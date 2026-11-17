import test from 'node:test';
import assert from 'node:assert/strict';
import { readOffer, readOrder, readProduct, orderTransition, quoteCart } from '../src/commerce.js';

const id = '821ed141-15fe-47e1-8e67-0c4562ce370e';
const product = { id, name: 'Capacete', description: 'Novo', category: 'Equipamento', price_minor: 22550, stock: 3, visible: true, images: [] };
const validOrder = { request_id: id, customer_name: 'Cliente', customer_phone: '+244 923 123 456', expected_total_minor: 45100, items: [{ product_id: id, quantity: 2 }] };

test('course offers validate visibility, catalogue position and up to five local images', () => {
  const body = { name: '', description: '', price_minor: null, per_lesson: false, images: [], visible: true, position: 10 };
  assert.deepEqual(readOffer(body, 'course1'), ['', '', null, false, [], true, 10]);
  assert.throws(() => readOffer(body, id), { status: 422 });
  const pictures = Array.from({ length: 5 }, (_, index) => `/media/course-images/catalog/curso-${index}.jpg`);
  assert.deepEqual(readOffer({ ...body, images: pictures }, 'course1')[4], pictures);
  assert.throws(() => readOffer({ ...body, images: [...pictures, '/media/course-images/catalog/curso-6.jpg'] }, 'course1'), { status: 422 });
  for (const url of ['/media/course-images/catalog/../bad.jpg', '/media/shop-images/catalog/a.jpg', 'https://example.invalid/pic.png', '/media/course-images/catalog/a.pdf']) {
    assert.throws(() => readOffer({ ...body, images: [url] }, 'course1'), { status: 422 });
  }
});

test('products reject negative inventory, fractional minor units and false string booleans', () => {
  assert.deepEqual(readProduct(product), ['Capacete', 'Novo', 'Equipamento', 22550, [], 3, true]);
  for (const invalid of [{ stock: -1 }, { price_minor: 4.2 }, { price_minor: 0 }, { visible: 'false' }]) {
    assert.throws(() => readProduct({ ...product, ...invalid }), { status: 422 });
  }
});

test('guest checkout rejects duplicated products and ignores client-supplied unit price', () => {
  const order = readOrder({ ...validOrder, items: [{ ...validOrder.items[0], price_minor: 1 }] });
  assert.equal(order.phone, '244923123456');
  assert.equal(readOrder({ ...validOrder, customer_phone: '923123456' }).phone, order.phone);
  assert.deepEqual(order.items, validOrder.items);
  assert.throws(() => readOrder({ ...validOrder, items: [...validOrder.items, ...validOrder.items] }), { status: 422 });
  assert.equal(quoteCart(order.items, [product]).total, 45100);
  assert.throws(() => quoteCart(order.items, [{ ...product, stock: 1 }]), { status: 409 });
  assert.throws(() => quoteCart(order.items, [{ ...product, visible: false }]), { status: 409 });
});

test('order lifecycle reserves and releases inventory only on valid transitions', () => {
  assert.equal(orderTransition('pending', 'confirmed'), -1);
  assert.equal(orderTransition('confirmed', 'cancelled'), 1);
  assert.equal(orderTransition('pending', 'cancelled'), 0);
  assert.equal(orderTransition('confirmed', 'confirmed'), 0);
  assert.equal(orderTransition('confirmed', 'paid'), 0);
  assert.equal(orderTransition('paid', 'completed'), 0);
  assert.throws(() => orderTransition('pending', 'paid'), { status: 409 });
  assert.throws(() => orderTransition('paid', 'cancelled'), { status: 409 });
});
