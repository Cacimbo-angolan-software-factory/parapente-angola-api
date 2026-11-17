import { randomUUID } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultCourses = ['course1', 'course2', 'course3'];
const statuses = ['pending', 'confirmed', 'paid', 'completed', 'cancelled'];
const moneyLimit = 99_999_999_999;
// pg returns bigint columns as strings. The limits keep these values within safe JSON integers.
const numericMoney = (row, field = 'price_minor') => ({
  ...row, [field]: row[field] === null ? null : Number(row[field]),
});
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const invalid = (field) => fail(422, `Verifique o campo: ${field}.`);
const object = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('dados');
  return body;
};
const string = (value, field, max, required = false) => {
  if (typeof value !== 'string') invalid(field);
  const clean = value.trim();
  if ((required && !clean) || clean.length > max || clean.includes('\0')) invalid(field);
  return clean;
};
const integer = (value, field, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value;
};
const bool = (value, field) => typeof value === 'boolean' ? value : invalid(field);
const images = (value, bucket) => {
  const pattern = new RegExp(`^/media/${bucket}/[a-z0-9_-]+/[a-z0-9_.-]+\\.(?:jpg|png|webp|avif|gif)$`, 'i');
  if (!Array.isArray(value) || value.length > 5 || value.some((url) => (
    typeof url !== 'string' || url.length > 300 || url.includes('..') || !pattern.test(url)
  ))) invalid('imagens (até 5 imagens carregadas)');
  return [...new Set(value)];
};

export function readOffer(body, id) {
  const data = object(body);
  const custom = !defaultCourses.includes(id);
  return [
    string(data.name, 'nome', 120, custom),
    string(data.description, 'descrição', 2000, custom),
    data.price_minor === null ? null : integer(data.price_minor, 'preço', 0, moneyLimit),
    bool(data.per_lesson, 'preço por aula'),
    images(data.images, 'course-images'),
    bool(data.visible, 'visibilidade'),
    integer(data.position, 'ordem', 0, 9999),
  ];
}

export function readProduct(body) {
  const data = object(body);
  return [
    string(data.name, 'nome', 120, true),
    string(data.description, 'descrição', 2000),
    string(data.category, 'categoria', 80, true),
    integer(data.price_minor, 'preço', 1, moneyLimit),
    images(data.images, 'shop-images'),
    integer(data.stock, 'stock', 0, 1_000_000),
    bool(data.visible, 'publicação'),
  ];
}

export function readOrder(body) {
  const data = object(body);
  if (typeof data.request_id !== 'string' || !uuid.test(data.request_id)) invalid('referência');
  const phone = string(data.customer_phone, 'telefone', 40, true).replace(/[\s().-]/g, '').replace(/^00/, '+');
  if (!/^\+?[0-9]{8,15}$/.test(phone)) invalid('telefone');
  const normalizedPhone = /^9\d{8}$/.test(phone) ? `244${phone}` : phone.replace(/^\+/, '');
  const email = string(data.customer_email ?? '', 'email', 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('email');
  if (!Array.isArray(data.items) || !data.items.length || data.items.length > 20) invalid('carrinho (até 20 artigos)');
  const seen = new Set();
  const items = data.items.map((rawItem) => {
    const item = object(rawItem);
    const id = string(item.product_id, 'artigo', 36, true).toLowerCase();
    if (!uuid.test(id) || seen.has(id)) invalid('artigos do carrinho');
    seen.add(id);
    return { product_id: id, quantity: integer(item.quantity, 'quantidade', 1, 99) };
  }).sort((a, b) => a.product_id.localeCompare(b.product_id));
  return {
    requestId: data.request_id,
    name: string(data.customer_name, 'nome', 120, true),
    phone: normalizedPhone, email,
    notes: string(data.notes ?? '', 'observações', 500),
    expectedTotal: integer(data.expected_total_minor, 'total', 1, Number.MAX_SAFE_INTEGER),
    items,
  };
}

export function quoteCart(items, products) {
  const byId = new Map(products.map(product => [product.id, product]));
  const lines = items.map(({ product_id, quantity }) => {
    const product = byId.get(product_id);
    if (!product || !product.visible || product.stock < quantity) {
      fail(409, 'Um dos artigos já não está disponível na quantidade pedida. Reveja o carrinho.');
    }
    return { product_id, name: product.name, quantity, price_minor: Number(product.price_minor) };
  });
  return { lines, total: lines.reduce((sum, line) => sum + line.price_minor * line.quantity, 0) };
}

export function orderTransition(from, to) {
  if (from === to) return 0;
  if (from === 'pending' && to === 'confirmed') return -1;
  if (from === 'confirmed' && to === 'cancelled') return 1;
  if ((from === 'pending' && to === 'cancelled') || (from === 'confirmed' && to === 'paid') ||
      (from === 'paid' && to === 'completed')) return 0;
  return fail(409, 'Esta mudança de estado não é permitida.');
}

async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function courseCatalog(pool, admin) {
  const { rows: [settings] } = await pool.query(
    `SELECT show_price_table,
      COALESCE((SELECT json_agg(c ORDER BY c.position,c.id) FROM platform_commerce.course_offers c WHERE $1 OR c.visible), '[]') AS offers,
      ARRAY(SELECT id FROM platform_commerce.course_offers WHERE NOT visible AND id=ANY($2::text[])) AS hidden_defaults
     FROM platform_commerce.course_settings`, [admin, defaultCourses],
  );
  return settings;
}

async function saveCourse(pool, id, payload, create) {
  const values = readOffer(payload, id);
  if (!defaultCourses.includes(id) && !create) {
    const { rows: [offer] } = await pool.query(
      `UPDATE platform_commerce.course_offers
       SET name=$2,description=$3,price_minor=$4,per_lesson=$5,images=$6,visible=$7,position=$8
       WHERE id=$1 RETURNING *`, [id, ...values],
    );
    if (!offer) fail(404, 'Curso não encontrado.');
    return offer;
  }
  const { rows: [offer] } = await pool.query(
    `INSERT INTO platform_commerce.course_offers (id,name,description,price_minor,per_lesson,images,visible,position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,price_minor=EXCLUDED.price_minor,
     per_lesson=EXCLUDED.per_lesson,images=EXCLUDED.images,visible=EXCLUDED.visible,position=EXCLUDED.position
     RETURNING *`, [id, ...values],
  );
  return offer;
}

async function submitOrder(pool, body) {
  const order = readOrder(body);
  return transaction(pool, async (client) => {
    // A retry after a network timeout returns the same reference without another order.
    await client.query('SELECT pg_advisory_xact_lock(76110, hashtext($1))', [order.requestId.toLowerCase()]);
    const { rows: [existing] } = await client.query(
      'SELECT id, total_minor, customer_phone FROM platform_commerce.shop_orders WHERE request_id=$1', [order.requestId],
    );
    if (existing) {
      if (existing.customer_phone !== order.phone) fail(409, 'Referência de encomenda inválida. Reveja o pedido.');
      return { id: existing.id, total_minor: existing.total_minor, repeated: true };
    }

    await client.query('SELECT pg_advisory_xact_lock(76111, hashtext($1))', [order.phone]);
    const { rows: [{ count }] } = await client.query(
      `SELECT count(*)::int FROM platform_commerce.shop_orders WHERE customer_phone=$1
       AND created_at > now() - interval '15 minutes'`, [order.phone],
    );
    if (count >= 5) fail(429, 'Aguarde alguns minutos antes de enviar outra encomenda.');
    const { rows: products } = await client.query(
      `SELECT id,name,price_minor,stock,visible FROM platform_commerce.shop_products
       WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`, [order.items.map(item => item.product_id)],
    );
    const { lines, total } = quoteCart(order.items, products);
    if (total !== order.expectedTotal) fail(409, 'O preço foi atualizado. Reveja o total e volte a confirmar.');
    const { rows: [created] } = await client.query(
      `INSERT INTO platform_commerce.shop_orders
       (request_id, customer_name, customer_phone, customer_email, notes, items, total_minor)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id,total_minor`,
      [order.requestId, order.name, order.phone, order.email, order.notes, JSON.stringify(lines), total],
    );
    return { ...created, repeated: false };
  });
}

async function updateOrder(pool, id, status) {
  if (!statuses.includes(status)) invalid('estado');
  return transaction(pool, async (client) => {
    const { rows: [order] } = await client.query(
      'SELECT id,items,status FROM platform_commerce.shop_orders WHERE id=$1 FOR UPDATE', [id],
    );
    if (!order) fail(404, 'Encomenda não encontrada.');
    if (order.status === status) return order;
    const stockChange = orderTransition(order.status, status);
    if (stockChange) {
      for (const item of order.items) {
        const difference = item.quantity * stockChange;
        const { rowCount } = await client.query(
          `UPDATE platform_commerce.shop_products SET stock=stock+$2::int,version=version+1 WHERE id=$1
           AND stock+$2::int BETWEEN 0 AND 1000000 AND ($2::int > 0 OR visible)`, [item.product_id, difference],
        );
        if (!rowCount) fail(409, stockChange < 0
          ? `Stock insuficiente ou artigo oculto: ${item.name}.`
          : `Não foi possível devolver o stock de ${item.name}. Reveja o inventário.`);
      }
    }
    const { rows: [updated] } = await client.query(
      'UPDATE platform_commerce.shop_orders SET status=$2,updated_at=now() WHERE id=$1 RETURNING id,status,updated_at',
      [id, status],
    );
    return updated;
  });
}

export function createCommerceHandler({ pool, requireActiveAdmin, send, jsonBody }) {
  return async (req, res, url, headers) => {
    const { pathname: path } = url;
    if (!/^\/(?:catalog|admin\/commerce)(?:\/|$)/.test(path)) return false;
    const reply = (status, data) => {
      send(res, status, data, { ...headers, 'Cache-Control': 'no-store' });
      return true;
    };
    const method = req.method;
    const readBody = () => jsonBody(req, 24_000);
    const admin = path.startsWith('/admin/commerce');
    if (admin) await requireActiveAdmin(req);

    if (method === 'GET' && ['/catalog/courses', '/admin/commerce/courses'].includes(path)) {
      return reply(200, await courseCatalog(pool, admin));
    }
    if (method === 'PUT' && path === '/admin/commerce/course-settings') {
      const flag = bool(object(await readBody()).show_price_table, 'mostrar tabela');
      await pool.query('UPDATE platform_commerce.course_settings SET show_price_table=$1', [flag]);
      return reply(200, { show_price_table: flag });
    }
    if (method === 'POST' && path === '/admin/commerce/courses') {
      return reply(201, numericMoney(await saveCourse(pool, randomUUID(), await readBody(), true)));
    }
    const courseId = path.match(/^\/admin\/commerce\/courses\/([^/]+)$/)?.[1];
    if (method === 'PUT' && courseId && (defaultCourses.includes(courseId) || uuid.test(courseId))) {
      return reply(200, numericMoney(await saveCourse(pool, courseId, await readBody(), false)));
    }

    if (method === 'GET' && ['/catalog/products', '/admin/commerce/products'].includes(path)) {
      const { rows } = await pool.query(admin
        ? 'SELECT * FROM platform_commerce.shop_products ORDER BY name,id'
        : 'SELECT id,name,description,category,price_minor,images,stock>0 AS available FROM platform_commerce.shop_products WHERE visible ORDER BY name,id');
      return reply(200, rows.map(row => numericMoney(row)));
    }
    if (method === 'POST' && path === '/admin/commerce/products') {
      const { rows: [product] } = await pool.query(
        `INSERT INTO platform_commerce.shop_products (name,description,category,price_minor,images,stock,visible)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, readProduct(await readBody()),
      );
      return reply(201, numericMoney(product));
    }
    const productId = path.match(/^\/admin\/commerce\/products\/([^/]+)$/)?.[1];
    if (method === 'PUT' && productId && uuid.test(productId)) {
      const data = await readBody();
      const values = readProduct(data);
      const version = integer(data.version, 'versão do artigo', 1, 2_147_483_646);
      const { rows: [product] } = await pool.query(
        `UPDATE platform_commerce.shop_products SET name=$2,description=$3,category=$4,price_minor=$5,images=$6,
         stock=$7,visible=$8,version=version+1 WHERE id=$1 AND version=$9 RETURNING *`, [productId, ...values, version],
      );
      if (!product) fail(409, 'O artigo ou o seu stock mudou. Recarregue a lista antes de editar.');
      return reply(200, numericMoney(product));
    }
    if (method === 'POST' && path === '/catalog/orders') {
      const { id, total_minor, repeated } = await submitOrder(pool, await readBody());
      return reply(repeated ? 200 : 201, numericMoney({ id, total_minor }, 'total_minor'));
    }
    if (method === 'GET' && path === '/admin/commerce/orders') {
      const status = url.searchParams.get('status');
      if (status && !statuses.includes(status)) invalid('estado');
      const page = integer(Number(url.searchParams.get('page') ?? 1), 'página', 1, 100_000);
      const { rows } = await pool.query(
        `SELECT id,customer_name,customer_phone,customer_email,notes,items,total_minor,status,created_at,updated_at
         FROM platform_commerce.shop_orders WHERE $1::text IS NULL OR status=$1
         ORDER BY created_at DESC,id LIMIT 51 OFFSET $2`, [status || null, (page - 1) * 50],
      );
      return reply(200, { orders: rows.slice(0, 50).map(row => numericMoney(row, 'total_minor')), has_more: rows.length > 50 });
    }
    const orderId = path.match(/^\/admin\/commerce\/orders\/([^/]+)\/status$/)?.[1];
    if (method === 'PATCH' && orderId && uuid.test(orderId)) {
      return reply(200, await updateOrder(pool, orderId, object(await readBody()).status));
    }
    return reply(404, { message: 'Página não encontrada.' });
  };
}
