import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { randomBytes, randomInt, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import pg from 'pg';
import { parseIgc } from './igc.js';

const { Pool } = pg;
const port = Number(process.env.PORT || 8080);
const databaseUrl = required('DATABASE_URL');
const jwtSecretValue = required('JWT_SECRET', 32);
const jwtSecret = new TextEncoder().encode(jwtSecretValue);
const migrationToken = process.env.MIGRATION_TOKEN || '';
const postgrestUrl = process.env.POSTGREST_URL || 'http://postgrest:3000';
const smtpEndpoint = process.env.SMTP_ENDPOINT || '';
const whatsappEndpoint = process.env.WHATSAPP_ENDPOINT || '';
const whatsappApiToken = process.env.WHATSAPP_API_TOKEN || '';
const frontendUrl = (process.env.FRONTEND_URL || 'https://www.parapenteangola.com').replace(/\/+$/, '');
const platformNotificationEmail = process.env.ADMIN_NOTIFICATION_EMAIL || 'info@cacimboerp.com';
const accessTokenTtlSeconds = Math.min(Math.max(Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 14400), 900), 86400);
const allowedOrigins = new Set((process.env.CORS_ORIGINS || '')
  .split(',').map((item) => item.trim()).filter(Boolean));
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const bookingEventClients = new Set();
const weatherCache = new Map();

const publicReadTables = new Set([
  'activities', 'equipment_types', 'extras', 'flight_zones', 'gallery_images',
  'payment_methods', 'pilot_event_types', 'sponsors', 'trainings',
]);
const clientWriteTables = new Set(['activity_bookings', 'bookings', 'booking_extras', 'profiles']);
const pilotWriteTables = new Set(['flight_logs', 'flight_evaluations', 'pilot_event_log', 'profiles']);
const agentWriteTables = new Set(['bookings', 'booking_extras', 'flight_logs', 'flight_evaluations', 'pilot_event_log', 'profiles']);
const publicRpcs = new Set(['get_active_pilots_and_students', 'get_public_pilot_profile']);
const authenticatedRpcs = new Set(['get_admin_emails']);
const pilotRpcs = new Set(['get_pilot_commissions']);
const agentSensitiveTables = new Set(['agent_clients', 'agent_commission_rules', 'agent_commissions']);
const importTables = new Set([
  'activities', 'activity_bookings', 'activity_vouchers', 'booking_extras', 'bookings',
  'equipment', 'equipment_types', 'erp_settings', 'extras', 'flight_evaluations',
  'flight_logs', 'flight_zones', 'gallery_images', 'licencas', 'payment_methods',
  'pilot_event_log', 'pilot_event_types', 'profiles', 'receipt_items', 'receipt_payments',
  'receipts', 'sponsors', 'sponsorship_pilot_allocations', 'sponsorships',
  'training_participants', 'trainings', 'vouchers', 'platform_users', 'agent_clients',
  'agent_commission_rules', 'agent_commissions',
]);

function required(name, minLength = 1) {
  const value = process.env[name] || '';
  if (value.length < minLength) throw new Error(`${name} is required and must contain at least ${minLength} characters`);
  return value;
}

function corsHeaders(origin) {
  const allowed = origin && (allowedOrigins.has(origin) || allowedOrigins.has('*'));
  return {
    ...(allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey, prefer, range, x-platform-project',
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS',
    'Access-Control-Expose-Headers': 'content-range, preference-applied',
  };
}

function send(res, status, payload, headers = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function bookingEventPayload(booking, action = 'updated') {
  return {
    type: 'booking.changed',
    action,
    booking_id: booking?.id || null,
    agent_id: booking?.agent_id || null,
    status: booking?.status || null,
    occurred_at: new Date().toISOString(),
  };
}

function broadcastBookingChange(booking, action = 'updated') {
  const event = bookingEventPayload(booking, action);
  const data = `event: booking\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of bookingEventClients) {
    const canReceive = client.role === 'admin'
      || (client.role === 'agent' && event.agent_id === client.userId);
    if (!canReceive) continue;
    try { client.res.write(data); }
    catch { bookingEventClients.delete(client); }
  }
  void deliverBookingNotification(booking, action).catch((error) => {
    console.error('Failed to deliver booking notification:', error.message);
  });
  void deliverPilotBookingNotification(booking, action).catch((error) => {
    console.error('Failed to deliver pilot booking notification:', error.message);
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

async function deliverBookingNotification(booking, action) {
  if (!booking?.id) return;
  let recipient = platformNotificationEmail;
  let recipientName = 'Parapente Angola';
  if (booking.agent_id) {
    const result = await pool.query(
      `SELECT p.name,p.company_name,p.company_email,u.email
       FROM profiles p LEFT JOIN platform_users u ON u.id=p.id WHERE p.id=$1`,
      [booking.agent_id],
    );
    const agent = result.rows[0];
    recipient = agent?.company_email || (agent?.email?.endsWith('@whatsapp.parapenteangola.invalid') ? '' : agent?.email) || '';
    recipientName = agent?.company_name || agent?.name || 'Agente';
  }
  if (!recipient) return;
  const actionLabel = action === 'created' ? 'Nova reserva' : action === 'deleted' ? 'Reserva eliminada' : 'Reserva alterada';
  const clientName = booking.client_details?.name || 'Cliente';
  const bookingCode = booking.booking_code || booking.id.slice(0, 8);
  const subject = `${actionLabel} ${bookingCode} — Parapente Angola`;
  const html = `<p>Olá ${escapeHtml(recipientName)},</p>
    <p><strong>${escapeHtml(actionLabel)}</strong> na plataforma.</p>
    <ul>
      <li><strong>Reserva:</strong> ${escapeHtml(bookingCode)}</li>
      <li><strong>Cliente:</strong> ${escapeHtml(clientName)}</li>
      <li><strong>Data:</strong> ${escapeHtml(booking.booking_date || '—')} ${escapeHtml(booking.booking_time || '')}</li>
      <li><strong>Estado:</strong> ${escapeHtml(booking.status || '—')}</li>
    </ul>
    <p><a href="${frontendUrl}/${booking.agent_id ? 'agent' : 'admin?tab=schedule'}">Abrir painel de reservas</a></p>`;
  await sendEmail(recipient, subject, html, booking.id);
}

async function deliverPilotBookingNotification(booking, action) {
  if (!booking?.id || !booking?.provider_id) return;

  const [pilotResult, bookingResult] = await Promise.all([
    pool.query(
      `SELECT p.name,p.phone,u.email
       FROM profiles p LEFT JOIN platform_users u ON u.id=p.id
       WHERE p.id=$1 AND p.role IN ('pilot','provider','aluno','student')`,
      [booking.provider_id],
    ),
    pool.query(
      `SELECT b.booking_code,b.booking_date,b.booking_time,b.status,b.total_price,
              COALESCE(b.client_details->>'name',client.name,'Cliente') AS client_name,
              location.name AS location_name,activity.name AS activity_name
       FROM bookings b
       LEFT JOIN profiles client ON client.id=b.client_id
       LEFT JOIN flight_zones location ON location.id=b.location_id
       LEFT JOIN activities activity ON activity.id=b.activity_id
       WHERE b.id=$1`,
      [booking.id],
    ),
  ]);

  const pilot = pilotResult.rows[0];
  if (!pilot) return;
  const details = { ...booking, ...(bookingResult.rows[0] || {}) };
  const email = pilot.email?.endsWith('@whatsapp.parapenteangola.invalid') ? '' : String(pilot.email || '').trim();
  const phone = normalizePhone(pilot.phone);
  const actionLabel = action === 'created' ? 'Nova reserva atribuída' : action === 'deleted' ? 'Reserva eliminada' : 'Reserva atribuída/alterada';
  const bookingCode = details.booking_code || booking.id.slice(0, 8).toUpperCase();
  const clientName = details.client_name || details.client_details?.name || 'Cliente';
  const activityName = details.activity_name || 'Atividade';
  const locationName = details.location_name || 'Local a confirmar';
  const dateAndTime = `${details.booking_date || 'Data a confirmar'} ${details.booking_time || ''}`.trim();
  const totalPrice = Number(details.total_price || 0);
  const amountLabel = totalPrice > 0 ? `${totalPrice.toLocaleString('pt-PT')} AOA` : 'A confirmar';
  const pilotUrl = `${frontendUrl}/pilot`;

  const deliveries = [];
  if (/^2449\d{8}$/.test(phone)) {
    deliveries.push(sendWhatsApp(phone, [
      `Olá ${pilot.name || 'Piloto'},`,
      `${actionLabel}: ${bookingCode}`,
      `Cliente: ${clientName}`,
      `Atividade: ${activityName}`,
      `Local: ${locationName}`,
      `Data: ${dateAndTime}`,
      `Estado: ${details.status || '—'}`,
      `Valor: ${amountLabel}`,
      `Consultar: ${pilotUrl}`,
    ].join('\n')));
  }
  if (/^\S+@\S+\.\S+$/.test(email)) {
    const subject = `${actionLabel} ${bookingCode} — Parapente Angola`;
    const html = `<p>Olá ${escapeHtml(pilot.name || 'Piloto')},</p>
      <p><strong>${escapeHtml(actionLabel)}</strong>.</p>
      <ul>
        <li><strong>Reserva:</strong> ${escapeHtml(bookingCode)}</li>
        <li><strong>Cliente:</strong> ${escapeHtml(clientName)}</li>
        <li><strong>Atividade:</strong> ${escapeHtml(activityName)}</li>
        <li><strong>Local:</strong> ${escapeHtml(locationName)}</li>
        <li><strong>Data:</strong> ${escapeHtml(dateAndTime)}</li>
        <li><strong>Estado:</strong> ${escapeHtml(details.status || '—')}</li>
        <li><strong>Valor:</strong> ${escapeHtml(amountLabel)}</li>
      </ul>
      <p><a href="${pilotUrl}">Abrir painel do piloto</a></p>`;
    deliveries.push(sendEmail(email, subject, html, booking.id));
  }

  const results = await Promise.allSettled(deliveries);
  const failures = results.filter((result) => result.status === 'rejected');
  for (const failure of failures) console.error('Pilot notification channel failed:', failure.reason?.message || failure.reason);
  if (deliveries.length && failures.length === deliveries.length) {
    throw new Error('All configured pilot notification channels failed');
  }
}

async function streamBookingEvents(req, res, headers) {
  const auth = await authenticate(req);
  if (!['admin', 'agent'].includes(auth.role)) {
    return send(res, 403, { message: 'Operação não autorizada.' }, headers);
  }
  res.writeHead(200, {
    ...headers,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ connected: true })}\n\n`);
  const client = { res, role: auth.role, userId: auth.sub };
  bookingEventClients.add(client);
  const keepAlive = setInterval(() => {
    try { res.write(': keep-alive\n\n'); }
    catch { clearInterval(keepAlive); bookingEventClients.delete(client); }
  }, 20_000);
  const cleanup = () => { clearInterval(keepAlive); bookingEventClients.delete(client); };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

async function jsonBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

function bearer(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return match?.[1] || null;
}

function normalizeRole(role) {
  const value = String(role || '').trim().toLowerCase();
  return value === 'administrador' ? 'admin' : value || 'client';
}

async function authenticate(req, optional = false) {
  const token = bearer(req);
  if (!token) {
    if (optional) return null;
    throw Object.assign(new Error('Authentication required'), { status: 401 });
  }
  try {
    const { payload } = await jwtVerify(token, jwtSecret, { issuer: 'parapente-angola-api', audience: 'parapente-angola' });
    return payload;
  } catch {
    throw Object.assign(new Error('Invalid or expired token'), { status: 401 });
  }
}

async function issueSession(user) {
  const role = normalizeRole(user.role);
  const accessToken = await new SignJWT({ role, email: user.email })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(user.id)
    .setIssuer('parapente-angola-api').setAudience('parapente-angola')
    .setIssuedAt().setExpirationTime(`${accessTokenTtlSeconds}s`).sign(jwtSecret);
  const refreshToken = randomBytes(48).toString('base64url');
  const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
  await pool.query(
    `INSERT INTO platform_refresh_tokens (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + interval '30 days')`,
    [tokenHash, user.id],
  );
  const profile = await pool.query('SELECT * FROM profiles WHERE id = $1', [user.id]);
  return {
    access_token: accessToken, refresh_token: refreshToken, token_type: 'bearer', expires_in: accessTokenTtlSeconds,
    user: {
      id: user.id,
      email: user.email?.endsWith('@whatsapp.parapenteangola.invalid') ? '' : user.email,
      phone: user.phone || profile.rows[0]?.phone || '',
      role,
      user_metadata: { name: profile.rows[0]?.name || user.name || '' },
    },
  };
}

async function signUp(req, res, headers) {
  const body = await jsonBody(req);
  const channel = body.channel === 'whatsapp' ? 'whatsapp' : 'email';
  const email = channel === 'email' ? String(body.email || body.contact || '').trim().toLowerCase() : '';
  const phone = channel === 'whatsapp' ? normalizePhone(body.phone || body.contact) : '';
  const contact = channel === 'email' ? email : phone;
  const password = String(body.password || '');
  const name = String(body.options?.data?.name || body.name || '').trim();
  if (!name || password.length < 8 || (channel === 'email' && !/^\S+@\S+\.\S+$/.test(email)) || (channel === 'whatsapp' && !/^2449\d{8}$/.test(phone))) {
    return send(res, 422, { message: 'Preencha um nome, um contacto válido e uma palavra-passe com pelo menos 8 caracteres.' }, headers);
  }
  const existing = channel === 'email'
    ? await pool.query(
      'SELECT id,password_hash,guest_booking_at FROM platform_users WHERE lower(email)=lower($1)',
      [email],
    )
    : await pool.query(
      `SELECT u.id,u.password_hash,u.guest_booking_at
       FROM platform_users u LEFT JOIN profiles p ON p.id=u.id
       WHERE u.phone=$1 OR right(regexp_replace(COALESCE(p.phone,''),'\\D','','g'),9)=right($1,9)`,
      [phone],
    );
  if (existing.rowCount && !existing.rows[0].guest_booking_at) {
    return send(res, 409, { message: 'Já existe uma conta com este contacto.' }, headers);
  }

  const recent = await pool.query(
    `SELECT count(*)::int AS total FROM platform_signup_challenges
     WHERE contact=$1 AND created_at > now() - interval '15 minutes'`, [contact],
  );
  if (recent.rows[0].total >= 3) return send(res, 429, { message: 'Aguarde alguns minutos antes de pedir outro código.' }, headers);

  const challengeId = randomUUID();
  const code = String(randomInt(100000, 1000000));
  const passwordHash = await bcrypt.hash(password, 12);
  const codeHash = signupCodeHash(challengeId, code);
  await pool.query('DELETE FROM platform_signup_challenges WHERE expires_at<=now()');
  await pool.query(
    `INSERT INTO platform_signup_challenges
      (id,channel,contact,email,phone,name,password_hash,code_hash,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now() + interval '10 minutes')`,
    [challengeId, channel, contact, email || null, phone || null, name, passwordHash, codeHash],
  );
  try {
    const message = `O seu código de confirmação Parapente Angola é ${code}. Expira em 10 minutos.`;
    if (channel === 'email') {
      await sendEmail(email, 'Confirmar registo — Parapente Angola', `<p>${message}</p><p>Se não pediu este registo, ignore esta mensagem.</p>`, challengeId);
    } else {
      await sendWhatsApp(phone, message, { purpose: 'verification', code });
    }
    return send(res, 200, { data: { challenge_id: challengeId, verification_required: true, channel, contact_hint: maskContact(channel, contact), expires_in: 600 }, error: null }, headers);
  } catch (error) {
    await pool.query('DELETE FROM platform_signup_challenges WHERE id=$1', [challengeId]);
    console.error(`Failed to deliver signup code through ${channel}:`, error.message);
    const message = channel === 'email'
      ? 'Não foi possível enviar o email de confirmação. Tente novamente dentro de alguns minutos.'
      : error.status === 429
        ? 'O serviço WhatsApp está temporariamente limitado. Aguarde alguns minutos ou confirme por email.'
        : 'Não foi possível enviar o código pelo WhatsApp. Tente novamente ou confirme por email.';
    return send(res, error.status === 429 ? 503 : 502, { message }, headers);
  }
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00244')) digits = digits.slice(2);
  if (digits.length === 9 && digits.startsWith('9')) digits = `244${digits}`;
  return digits;
}

function guestText(value, maxLength = 500) {
  return String(value || '').trim().slice(0, maxLength);
}

function guestBookingCode() {
  return `PA-${randomBytes(4).toString('hex').toUpperCase()}`;
}

async function createGuestBooking(req, res, headers) {
  const body = await jsonBody(req);
  const details = body.client_details && typeof body.client_details === 'object' ? body.client_details : body;
  const name = guestText(details.name, 160);
  const email = guestText(details.email, 254).toLowerCase();
  const phone = normalizePhone(details.phone);
  const notificationContact = guestText(details.notificationContact, 254) || email || phone;
  const locationId = guestText(body.location_id || details.locationId, 36);
  const activityId = guestText(body.activity_id || details.activityId, 36) || null;
  const providerId = guestText(body.provider_id || details.providerId, 36) || null;
  const bookingDate = guestText(body.booking_date || details.preferredDate, 10);
  const bookingTime = guestText(body.booking_time || details.preferredTime, 8);
  const extraIds = [...new Set(Array.isArray(body.extra_ids) ? body.extra_ids.map((id) => guestText(id, 36)).filter(Boolean) : [])];
  const voucherId = guestText(body.voucher_id, 36) || null;
  const age = Number(details.age);
  const weight = Number(details.weight);

  if (!name || (!/^\S+@\S+\.\S+$/.test(email) && !/^2449\d{8}$/.test(phone))
      || !/^[0-9a-f-]{36}$/i.test(locationId) || !/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)
      || !/^\d{2}:\d{2}(:\d{2})?$/.test(bookingTime) || !Number.isFinite(age) || age < 16 || age > 80
      || !Number.isFinite(weight) || weight < 40 || weight > 120 || details.acceptTerms !== true) {
    return send(res, 422, { message: 'Indique os dados obrigatórios, um email ou WhatsApp válido e aceite o termo de responsabilidade.' }, headers);
  }
  if (bookingDate < new Date().toISOString().slice(0, 10)) {
    return send(res, 422, { message: 'Escolha uma data futura para a reserva.' }, headers);
  }
  if ((activityId && !/^[0-9a-f-]{36}$/i.test(activityId))
      || (providerId && !/^[0-9a-f-]{36}$/i.test(providerId))
      || (voucherId && !/^[0-9a-f-]{36}$/i.test(voucherId))
      || extraIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
    return send(res, 422, { message: 'Um dos dados da reserva é inválido.' }, headers);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locationResult = await client.query(
      'SELECT id,price FROM flight_zones WHERE id=$1 AND is_active=true FOR SHARE', [locationId],
    );
    if (!locationResult.rowCount) throw Object.assign(new Error('O local selecionado já não está disponível.'), { status: 422 });

    let activity = null;
    if (activityId) {
      const activityResult = await client.query(
        'SELECT id,location_id,price FROM activities WHERE id=$1 FOR SHARE', [activityId],
      );
      activity = activityResult.rows[0];
      if (!activity || (activity.location_id && activity.location_id !== locationId)) {
        throw Object.assign(new Error('A atividade selecionada não está disponível neste local.'), { status: 422 });
      }
    }
    if (providerId) {
      const provider = await client.query(
        "SELECT id FROM profiles WHERE id=$1 AND status='active' AND role IN ('pilot','provider','aluno','student') FOR SHARE",
        [providerId],
      );
      if (!provider.rowCount) throw Object.assign(new Error('O responsável selecionado não está disponível.'), { status: 422 });
      const conflict = await client.query(
        "SELECT id FROM bookings WHERE provider_id=$1 AND booking_date=$2 AND booking_time=$3 AND status <> 'cancelled' FOR UPDATE",
        [providerId, bookingDate, bookingTime],
      );
      if (conflict.rowCount) throw Object.assign(new Error('O responsável selecionado já tem uma atividade nesse horário.'), { status: 409 });
    }

    const extrasResult = extraIds.length
      ? await client.query('SELECT id,price FROM extras WHERE id = ANY($1::uuid[]) AND is_active=true FOR SHARE', [extraIds])
      : { rows: [] };
    if (extrasResult.rows.length !== extraIds.length) throw Object.assign(new Error('Um dos extras selecionados já não está disponível.'), { status: 422 });

    let discount = 0;
    let voucher = null;
    const basePrice = Number(activity?.price ?? locationResult.rows[0].price ?? 0)
      + extrasResult.rows.reduce((sum, extra) => sum + Number(extra.price || 0), 0);
    if (voucherId) {
      const voucherResult = await client.query('SELECT * FROM vouchers WHERE id=$1 FOR UPDATE', [voucherId]);
      voucher = voucherResult.rows[0];
      if (!voucher?.is_active || (voucher.expiry_date && voucher.expiry_date < bookingDate)
          || (voucher.usage_limit && voucher.times_used >= voucher.usage_limit)
          || (voucher.min_booking_value && basePrice < Number(voucher.min_booking_value))) {
        throw Object.assign(new Error('O voucher não pode ser aplicado a esta reserva.'), { status: 422 });
      }
      discount = voucher.discount_type === 'percentage'
        ? basePrice * (Number(voucher.discount_value) / 100)
        : Number(voucher.discount_value);
      discount = Math.min(basePrice, Math.max(0, discount));
    }

    const contactLock = email || phone;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [contactLock]);
    const existing = await client.query(
      `SELECT u.id,u.password_hash,u.guest_booking_at FROM platform_users u
       LEFT JOIN profiles p ON p.id=u.id
       WHERE ($1::text <> '' AND lower(u.email)=lower($1)) OR ($2::text <> '' AND (u.phone=$2 OR p.phone=$2))
       FOR UPDATE`,
      [email, phone],
    );
    let clientId;
    if (existing.rowCount) {
      const account = existing.rows[0];
      if (!account.guest_booking_at || account.password_hash) {
        throw Object.assign(new Error('Este contacto já tem uma conta. Inicie sessão para concluir a reserva.'), { status: 409 });
      }
      clientId = account.id;
      await client.query(
        'UPDATE profiles SET name=$2,phone=COALESCE($3,phone),updated_at=now() WHERE id=$1', [clientId, name, phone || null],
      );
    } else {
      clientId = randomUUID();
      await client.query(
        `INSERT INTO platform_users (id,email,phone,role,guest_booking_at)
         VALUES ($1,$2,$3,'client',now())`,
        [clientId, email || `${phone}@whatsapp.parapenteangola.invalid`, phone || null],
      );
      await client.query(
        `INSERT INTO profiles (id,name,phone,role,status) VALUES ($1,$2,$3,'client','active')`,
        [clientId, name, phone || null],
      );
    }

    const booking = await client.query(
      `INSERT INTO bookings
        (client_id,provider_id,activity_id,location_id,booking_date,booking_time,status,total_price,booking_code,voucher_id,discount_amount,client_details)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11::jsonb)
       RETURNING *`,
      [clientId, providerId, activityId, locationId, bookingDate, bookingTime, basePrice - discount, guestBookingCode(), voucherId, discount,
        JSON.stringify({
          name, age, weight, gender: guestText(details.gender, 40), nationality: guestText(details.nationality, 100), phone, email,
          clientType: guestText(details.clientType, 50) || 'individual', emergencyContactName: guestText(details.emergencyContactName, 160),
          emergencyContactPhone: guestText(details.emergencyContactPhone, 60), medicalConditions: guestText(details.medicalConditions, 1000),
          notificationChannel: guestText(details.notificationChannel, 20) || (phone ? 'whatsapp' : 'email'), notificationContact,
          guest_booking: true,
        })],
    );
    if (extraIds.length) {
      await client.query(
        'INSERT INTO booking_extras (booking_id,extra_id) SELECT $1,unnest($2::uuid[])', [booking.rows[0].id, extraIds],
      );
    }
    if (voucher) await client.query('UPDATE vouchers SET times_used=times_used+1,updated_at=now() WHERE id=$1', [voucher.id]);
    await client.query('COMMIT');
    broadcastBookingChange(booking.rows[0], 'created');
    return send(res, 201, { data: { booking: { id: booking.rows[0].id, booking_code: booking.rows[0].booking_code, status: 'pending' } }, error: null }, headers);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

function signupCodeHash(challengeId, code) {
  return createHash('sha256').update(`${challengeId}:${code}:${jwtSecretValue}`).digest('hex');
}

function maskContact(channel, contact) {
  if (channel === 'whatsapp') return `${contact.slice(0, 5)}***${contact.slice(-3)}`;
  const [local, domain] = contact.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

async function canManagePilot(auth, pilotId) {
  if (auth.role === 'admin' || auth.sub === pilotId) return true;
  return false;
}

async function getXContestPilot(req, res, headers, pilotId) {
  const auth = await authenticate(req, true);
  const canManage = auth ? await canManagePilot(auth, pilotId) : false;
  const profileResult = await pool.query(
    `SELECT e.pilot_id,e.external_username,e.external_profile_url,e.fai_id_snapshot,
            e.consent_public,e.verified_at,e.updated_at,p.name
     FROM pilot_external_profiles e JOIN profiles p ON p.id=e.pilot_id
     WHERE e.pilot_id=$1 AND ($2::boolean OR e.consent_public=true)`, [pilotId, canManage],
  );
  const externalProfile = profileResult.rows[0] || null;
  if (!externalProfile && !canManage) return send(res, 200, { data: { profile: null, flights: [], stats: null }, error: null }, headers);
  const [flightsResult, statsResult] = await Promise.all([pool.query(
    `SELECT id,flown_at,duration_seconds,distance_km,max_altitude_m,average_speed_kmh,
            max_speed_kmh,takeoff_lat,takeoff_lon,landing_lat,landing_lon,track_points,
            igc_filename,signature_present,public,imported_at
     FROM external_flights WHERE pilot_id=$1 AND ($2::boolean OR public=true)
     ORDER BY flown_at DESC LIMIT 100`, [pilotId, canManage]), pool.query(
    `SELECT count(*)::int AS total_flights,COALESCE(sum(distance_km),0)::numeric AS total_distance_km,
            COALESCE(sum(duration_seconds),0)::bigint AS total_duration_seconds,
            COALESCE(max(distance_km),0)::numeric AS longest_distance_km,
            COALESCE(max(max_altitude_m),0)::int AS max_altitude_m
     FROM external_flights WHERE pilot_id=$1 AND ($2::boolean OR public=true)`, [pilotId, canManage]),
  ]);
  const flights = flightsResult.rows;
  const aggregate = statsResult.rows[0];
  const stats = aggregate.total_flights ? {
    total_flights: aggregate.total_flights,
    total_distance_km: Number(aggregate.total_distance_km),
    total_duration_seconds: Number(aggregate.total_duration_seconds),
    longest_distance_km: Number(aggregate.longest_distance_km),
    max_altitude_m: aggregate.max_altitude_m,
  } : null;
  return send(res, 200, { data: { profile: externalProfile, flights, stats }, error: null }, headers);
}

async function saveXContestPilot(req, res, headers, pilotId) {
  const auth = await authenticate(req);
  if (!(await canManagePilot(auth, pilotId))) return send(res, 403, { message: 'Operação não autorizada.' }, headers);
  const body = await jsonBody(req);
  const username = String(body.external_username || '').trim().slice(0, 100) || null;
  let profileUrl = String(body.external_profile_url || '').trim() || null;
  if (profileUrl) {
    try {
      const parsed = new URL(profileUrl);
      if (!['xcontest.org', 'www.xcontest.org'].includes(parsed.hostname.toLowerCase()) || parsed.protocol !== 'https:') throw new Error();
      profileUrl = parsed.toString();
    } catch { return send(res, 422, { message: 'Indique um URL HTTPS válido do XContest.' }, headers); }
  }
  const pilot = await pool.query("SELECT fai_id FROM profiles WHERE id=$1 AND role IN ('pilot','aluno','student')", [pilotId]);
  if (!pilot.rowCount) return send(res, 404, { message: 'Piloto não encontrado.' }, headers);
  const result = await pool.query(
    `INSERT INTO pilot_external_profiles
      (pilot_id,external_username,external_profile_url,fai_id_snapshot,consent_public,updated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (pilot_id) DO UPDATE SET external_username=EXCLUDED.external_username,
       external_profile_url=EXCLUDED.external_profile_url,fai_id_snapshot=EXCLUDED.fai_id_snapshot,
       consent_public=EXCLUDED.consent_public,updated_at=now()
     RETURNING pilot_id,external_username,external_profile_url,fai_id_snapshot,consent_public,verified_at,updated_at`,
    [pilotId, username, profileUrl, pilot.rows[0].fai_id, body.consent_public === true],
  );
  return send(res, 200, { data: result.rows[0], error: null }, headers);
}

async function importIgcFlight(req, res, headers, pilotId) {
  const auth = await authenticate(req);
  if (!(await canManagePilot(auth, pilotId))) return send(res, 403, { message: 'Operação não autorizada.' }, headers);
  const body = await jsonBody(req, 2_200_000);
  const filename = String(body.filename || 'tracklog.igc').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
  if (!filename.toLowerCase().endsWith('.igc')) return send(res, 422, { message: 'Selecione um ficheiro .igc.' }, headers);
  const parsed = parseIgc(body.content);
  const checksum = createHash('sha256').update(parsed.normalized).digest('hex');
  try {
    const result = await pool.query(
      `INSERT INTO external_flights
        (pilot_id,flown_at,duration_seconds,distance_km,max_altitude_m,average_speed_kmh,max_speed_kmh,
         takeoff_lat,takeoff_lon,landing_lat,landing_lon,track_points,igc_filename,igc_checksum,
         igc_content,signature_present,public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id,flown_at,duration_seconds,distance_km,max_altitude_m,average_speed_kmh,max_speed_kmh,
         igc_filename,signature_present,public,imported_at`,
      [pilotId, parsed.flownAt, parsed.durationSeconds, parsed.distanceKm, parsed.maxAltitudeM,
        parsed.averageSpeedKmh, parsed.maxSpeedKmh, parsed.takeoff.lat, parsed.takeoff.lon,
        parsed.landing.lat, parsed.landing.lon, JSON.stringify(parsed.trackPoints), filename, checksum,
        parsed.normalized, parsed.signaturePresent, body.public === true],
    );
    return send(res, 201, { data: result.rows[0], error: null }, headers);
  } catch (error) {
    if (error.code === '23505') return send(res, 409, { message: 'Este ficheiro IGC já foi importado para o piloto.' }, headers);
    throw error;
  }
}

async function deleteIgcFlight(req, res, headers, pilotId, flightId) {
  const auth = await authenticate(req);
  if (!(await canManagePilot(auth, pilotId))) return send(res, 403, { message: 'Operação não autorizada.' }, headers);
  const result = await pool.query('DELETE FROM external_flights WHERE id=$1 AND pilot_id=$2 RETURNING id', [flightId, pilotId]);
  if (!result.rowCount) return send(res, 404, { message: 'Voo importado não encontrado.' }, headers);
  return send(res, 200, { data: result.rows[0], error: null }, headers);
}

async function verifySignUp(req, res, headers) {
  const body = await jsonBody(req);
  const challengeId = String(body.challenge_id || '');
  const code = String(body.code || '').replace(/\D/g, '');
  const challengeResult = await pool.query(
    'SELECT * FROM platform_signup_challenges WHERE id=$1 AND expires_at>now() FOR UPDATE', [challengeId],
  );
  const challenge = challengeResult.rows[0];
  if (!challenge || challenge.attempts >= 5) return send(res, 400, { message: 'O código é inválido ou expirou.' }, headers);
  const suppliedHash = Buffer.from(signupCodeHash(challengeId, code), 'hex');
  const expectedHash = Buffer.from(challenge.code_hash, 'hex');
  if (suppliedHash.length !== expectedHash.length || !timingSafeEqual(suppliedHash, expectedHash)) {
    await pool.query('UPDATE platform_signup_challenges SET attempts=attempts+1 WHERE id=$1', [challengeId]);
    return send(res, 400, { message: 'O código introduzido não está correto.' }, headers);
  }

  const storedEmail = challenge.email || `${challenge.phone}@whatsapp.parapenteangola.invalid`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [challenge.contact]);
    const guest = await client.query(
      `SELECT id FROM platform_users
       WHERE guest_booking_at IS NOT NULL
         AND (($1::text IS NOT NULL AND lower(email)=lower($1)) OR ($2::text IS NOT NULL AND phone=$2))
       FOR UPDATE`,
      [challenge.email, challenge.phone],
    );
    let created;
    if (guest.rowCount) {
      const id = guest.rows[0].id;
      created = await client.query(
        `UPDATE platform_users
         SET email=$2,phone=COALESCE($3,phone),password_hash=$4,role='client',guest_booking_at=NULL,
             email_confirmed_at=CASE WHEN $5::boolean THEN now() ELSE email_confirmed_at END,
             phone_confirmed_at=CASE WHEN $6::boolean THEN now() ELSE phone_confirmed_at END,updated_at=now()
         WHERE id=$1 RETURNING id,email,phone,role`,
        [id, storedEmail, challenge.phone, challenge.password_hash, Boolean(challenge.email), Boolean(challenge.phone)],
      );
      await client.query(
        `UPDATE profiles SET name=$2,phone=COALESCE($3,phone),role='client',status='active',updated_at=now() WHERE id=$1`,
        [id, challenge.name, challenge.phone],
      );
    } else {
      const id = randomUUID();
      created = await client.query(
        `INSERT INTO platform_users (id,email,phone,password_hash,role,email_confirmed_at,phone_confirmed_at)
         VALUES ($1,$2,$3,$4,'client',$5,$6) RETURNING id,email,phone,role`,
        [id, storedEmail, challenge.phone, challenge.password_hash, challenge.email ? new Date() : null, challenge.phone ? new Date() : null],
      );
      await client.query(
        `INSERT INTO profiles (id,name,phone,role,status) VALUES ($1,$2,$3,'client','active')`,
        [id, challenge.name, challenge.phone],
      );
    }
    await client.query('DELETE FROM platform_signup_challenges WHERE id=$1', [challengeId]);
    await client.query('COMMIT');
    return send(res, 200, { data: await issueSession(created.rows[0]), error: null }, headers);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return send(res, 409, { message: 'Já existe uma conta com este contacto.' }, headers);
    throw error;
  } finally { client.release(); }
}

async function signIn(req, res, headers) {
  const body = await jsonBody(req);
  const identifier = String(body.identifier || body.email || '').trim().toLowerCase();
  const phone = normalizePhone(identifier);
  const result = await pool.query(
    `SELECT u.*, COALESCE(p.role,u.role,'client') AS effective_role, p.status
     FROM platform_users u LEFT JOIN profiles p ON p.id=u.id
     WHERE lower(u.email)=lower($1) OR ($2 <> '' AND regexp_replace(COALESCE(u.phone,p.phone,''),'\\D','','g')=$2)`, [identifier, phone],
  );
  const user = result.rows[0];
  if (!user || !user.password_hash || !(await bcrypt.compare(String(body.password || ''), user.password_hash))) {
    return send(res, 400, { message: 'Email ou palavra-passe incorretos.' }, headers);
  }
  if (user.status === 'suspended' || user.status === 'inactive') {
    return send(res, 403, { message: 'Esta conta não está ativa.' }, headers);
  }
  user.role = normalizeRole(user.effective_role);
  await pool.query('UPDATE platform_users SET last_sign_in_at=now(), updated_at=now() WHERE id=$1', [user.id]);
  return send(res, 200, { data: await issueSession(user), error: null }, headers);
}

async function refresh(req, res, headers) {
  const body = await jsonBody(req);
  const raw = String(body.refresh_token || '');
  const hash = createHash('sha256').update(raw).digest('hex');
  const result = await pool.query(
    `DELETE FROM platform_refresh_tokens r USING platform_users u
     LEFT JOIN profiles p ON p.id=u.id
     WHERE r.token_hash=$1 AND r.user_id=u.id AND r.expires_at>now()
     RETURNING u.id,u.email,u.phone,COALESCE(p.role,u.role) AS role`, [hash],
  );
  if (!result.rows[0]) return send(res, 401, { message: 'Sessão expirada.' }, headers);
  return send(res, 200, { data: await issueSession(result.rows[0]), error: null }, headers);
}

async function currentUser(req, res, headers) {
  const auth = await authenticate(req);
  const result = await pool.query(
    `SELECT u.id,u.email,COALESCE(p.role,u.role,'client') AS role,u.created_at
     FROM platform_users u LEFT JOIN profiles p ON p.id=u.id WHERE u.id=$1`, [auth.sub],
  );
  return send(res, 200, { data: { user: result.rows[0] || null }, error: null }, headers);
}

async function sendEmail(to, subject, html, subjectId) {
  if (!smtpEndpoint) throw new Error('SMTP endpoint is not configured');
  const token = await new SignJWT({ role: 'system', email: to })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(subjectId)
    .setIssuer('parapente-angola-api').setAudience('parapente-angola')
    .setIssuedAt().setExpirationTime('5m').sign(jwtSecret);
  const response = await fetch(smtpEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, subject, html }),
  });
  if (!response.ok) throw new Error(`SMTP endpoint returned ${response.status}`);
}

async function sendWhatsApp(phone, message, { purpose = 'notification', code } = {}) {
  if (!whatsappEndpoint || !whatsappApiToken) throw new Error('WhatsApp bridge is not configured');
  const response = await fetch(whatsappEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${whatsappApiToken}` },
    body: JSON.stringify({ message_body: message, number: phone, purpose, ...(code ? { code } : {}) }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.status !== 'accepted' || !result?.provider_message_id) {
    const error = new Error(`Cacimbo WhatsApp endpoint returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
}

async function getPublicLicense(req, res, headers, licenseId) {
  const result = await pool.query(
    `SELECT l.id,l.numero_licenca,l.license_type,l.nome_completo,l.nivel_certificacao,
            l.data_emissao,l.data_validade,p.role,p.status AS holder_status
     FROM licencas l
     LEFT JOIN profiles p ON p.id=l.piloto_id
     WHERE l.id=$1
     ORDER BY l.created_at DESC LIMIT 1`,
    [licenseId],
  );
  const license = result.rows[0];
  if (!license) return send(res, 404, { message: 'Licença não encontrada.' }, headers);

  const today = new Date().toISOString().slice(0, 10);
  const validity = license.data_validade < today
    ? 'expired'
    : license.data_validade <= new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
      ? 'expiring'
      : 'valid';
  return send(res, 200, { data: {
    id: license.id,
    number: license.numero_licenca,
    holder_name: license.nome_completo,
    holder_type: license.license_type === 'agent' ? 'agent' : 'pilot',
    level: license.nivel_certificacao,
    issued_at: license.data_emissao,
    valid_until: license.data_validade,
    validity,
    holder_active: license.holder_status ? license.holder_status === 'active' : true,
  }, error: null }, headers);
}

function wmoToPictocode(code) {
  if (code === 0) return 1;
  if (code === 1) return 2;
  if (code === 2) return 3;
  if (code === 3) return 4;
  if ([45, 48].includes(code)) return 5;
  if ([51, 53, 55, 56, 57].includes(code)) return 10;
  if ([61, 63, 66, 67].includes(code)) return 11;
  if (code === 65) return 12;
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 7;
  if (code === 80) return 8;
  if (code === 81) return 13;
  if (code === 82) return 14;
  if (code === 95) return 9;
  if ([96, 99].includes(code)) return 16;
  return 4;
}

function degreesToCompass(value) {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const degrees = Number(value);
  if (!Number.isFinite(degrees)) return '';
  return directions[Math.round(((degrees % 360) + 360) % 360 / 45) % directions.length];
}

async function getWeatherForecast(req, res, headers) {
  const body = await jsonBody(req, 20_000);
  const latitude = Number(body.lat);
  const longitude = Number(body.lon);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return send(res, 422, { message: 'Coordenadas geográficas inválidas.' }, headers);
  }

  const cacheKey = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return send(res, 200, cached.payload, headers);

  const query = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_direction_10m_dominant',
    timezone: 'auto',
    forecast_days: '7',
    wind_speed_unit: 'kmh',
  });
  let response;
  try {
    response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'ParapenteAngola/1.6' },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    console.error('Weather provider request failed:', error.message);
    return send(res, 503, { message: 'O serviço meteorológico está temporariamente indisponível.' }, headers);
  }
  if (!response.ok) {
    console.error(`Weather provider returned ${response.status}`);
    return send(res, 502, { message: 'Não foi possível obter a previsão meteorológica.' }, headers);
  }
  const data = await response.json();
  const daily = data?.daily;
  if (!Array.isArray(daily?.time)) {
    return send(res, 502, { message: 'O serviço meteorológico devolveu uma resposta inválida.' }, headers);
  }
  const directions = daily.wind_direction_10m_dominant || [];
  const payload = {
    data_day: {
      time: daily.time,
      pictocode_day: (daily.weather_code || []).map(wmoToPictocode),
      temperature_max: daily.temperature_2m_max || [],
      temperature_min: daily.temperature_2m_min || [],
      windspeed_max: daily.wind_speed_10m_max || [],
      winddirection: directions,
      winddirection_2char: directions.map(degreesToCompass),
    },
    metadata: { provider: 'Open-Meteo', timezone: data.timezone || 'auto', fetched_at: new Date().toISOString() },
  };
  weatherCache.set(cacheKey, { payload, expiresAt: Date.now() + 15 * 60_000 });
  if (weatherCache.size > 250) weatherCache.delete(weatherCache.keys().next().value);
  return send(res, 200, payload, headers);
}

const managedProfileFields = [
  'phone', 'nif', 'location', 'price', 'level', 'flight_hours', 'license_validity', 'cv',
  'verified', 'license_number', 'fai_id', 'xc_portugal_id', 'emergency_contact_name',
  'emergency_contact_phone', 'commission_percent', 'fai_certificate_url',
  'license_certificate_url', 'face_photo_url', 'full_body_photo_url', 'in_flight_photo_url',
  'pilot_lic_ao', 'level_history',
];

async function createManagedUser(req, res, headers) {
  const auth = await authenticate(req);
  const adminResult = await pool.query(
    `SELECT COALESCE(p.role,u.role) AS role,p.status FROM platform_users u
     LEFT JOIN profiles p ON p.id=u.id WHERE u.id=$1`, [auth.sub],
  );
  const admin = adminResult.rows[0];
  const isAdmin = auth.role === 'admin' && admin?.role === 'admin';
  const isAgent = auth.role === 'agent' && admin?.role === 'agent';
  if ((!isAdmin && !isAgent) || admin?.status !== 'active') {
    return send(res, 403, { message: 'Apenas administradores e agentes ativos podem criar utilizadores.' }, headers);
  }
  const body = await jsonBody(req);
  const profileInput = body.profile && typeof body.profile === 'object' ? body.profile : body;
  const name = String(profileInput.name || body.name || '').trim();
  const email = String(body.email || profileInput.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const requestedRole = String(body.role || profileInput.role || 'client').toLowerCase();
  const role = isAgent
    ? 'client'
    : (['admin', 'client', 'pilot', 'agent', 'aluno', 'student'].includes(requestedRole) ? requestedRole : 'client');
  const phone = normalizePhone(profileInput.phone || body.phone) || null;
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || (password && password.length < 8)) {
    return send(res, 422, { message: 'Indique nome, email válido e uma palavra-passe com pelo menos 8 caracteres, quando utilizada.' }, headers);
  }

  const id = randomUUID();
  const passwordHash = password ? await bcrypt.hash(password, 12) : null;
  const resetToken = password ? '' : randomBytes(40).toString('base64url');
  const resetHash = resetToken ? createHash('sha256').update(resetToken).digest('hex') : '';
  const profile = { name, role, status: profileInput.status === 'inactive' ? 'inactive' : 'active' };
  for (const field of managedProfileFields) {
    if (profileInput[field] !== undefined && profileInput[field] !== '') profile[field] = profileInput[field];
  }
  if (phone) profile.phone = phone;

  const columns = ['id', ...Object.keys(profile)];
  const values = [id, ...Object.values(profile)];
  const placeholders = values.map((_, index) => `$${index + 1}`).join(',');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO platform_users (id,email,phone,password_hash,role,email_confirmed_at)
       VALUES ($1,$2,$3,$4,$5,now())`, [id, email, phone, passwordHash, role],
    );
    await client.query(
      `INSERT INTO profiles (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${placeholders})`, values,
    );
    if (isAgent) {
      await client.query(
        'INSERT INTO agent_clients (agent_id,client_id) VALUES ($1,$2)',
        [auth.sub, id],
      );
    }
    if (resetHash) {
      await client.query(
        `INSERT INTO platform_password_resets (token_hash,user_id,expires_at)
         VALUES ($1,$2,now() + interval '48 hours')`, [resetHash, id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return send(res, 409, { message: 'Já existe uma conta com este email ou telefone.' }, headers);
    throw error;
  } finally { client.release(); }

  let invitationSent = true;
  if (resetToken) {
    const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;
    try {
      await sendEmail(email, 'Ativar conta — Parapente Angola', `<p>Olá ${name},</p><p>A sua conta foi criada.</p><p><a href="${resetUrl}">Definir palavra-passe e ativar conta</a></p><p>Este link expira em 48 horas.</p>`, id);
    } catch (error) {
      invitationSent = false;
      console.error('Failed to send managed-user invitation:', error.message);
    }
  }
  return send(res, 201, { data: { user: { id, email, role, name }, invitation_sent: invitationSent }, error: null }, headers);
}

async function requireActiveAdmin(req) {
  const auth = await authenticate(req);
  if (normalizeRole(auth.role) !== 'admin') throw Object.assign(new Error('Apenas administradores podem executar esta operação.'), { status: 403 });
  const result = await pool.query('SELECT role,status FROM profiles WHERE id=$1', [auth.sub]);
  if (normalizeRole(result.rows[0]?.role) !== 'admin' || result.rows[0]?.status !== 'active') {
    throw Object.assign(new Error('Apenas administradores activos podem executar esta operação.'), { status: 403 });
  }
  return auth;
}

async function renewLicense(req, res, headers) {
  const auth = await requireActiveAdmin(req);
  const body = await jsonBody(req);
  const licenseId = String(body.license_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(licenseId)) return send(res, 422, { message: 'Licença inválida.' }, headers);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const licenseResult = await client.query('SELECT * FROM licencas WHERE id=$1 FOR UPDATE', [licenseId]);
    const license = licenseResult.rows[0];
    if (!license) { await client.query('ROLLBACK'); return send(res, 404, { message: 'Licença não encontrada.' }, headers); }
    if (!license.piloto_id) { await client.query('ROLLBACK'); return send(res, 422, { message: 'A licença não está associada a um sócio.' }, headers); }
    const type = license.license_type === 'agent' ? 'agent' : 'pilot';
    const pending = await client.query(`SELECT id FROM license_renewals WHERE license_id=$1 AND status='pending' LIMIT 1`, [licenseId]);
    if (pending.rowCount) { await client.query('ROLLBACK'); return send(res, 409, { message: 'Já existe uma cobrança pendente para esta licença.' }, headers); }
    const feeResult = await client.query(
      `SELECT amount,currency FROM license_fee_rules
       WHERE license_type=$1 AND active=true AND effective_from<=CURRENT_DATE
         AND (effective_to IS NULL OR effective_to>=CURRENT_DATE)
       ORDER BY effective_from DESC, created_at DESC LIMIT 1`, [type],
    );
    const fee = feeResult.rows[0];
    if (!fee) {
      await client.query('ROLLBACK');
      return send(res, 422, { message: `Configure primeiro o preço de renovação para ${type === 'agent' ? 'agentes' : 'pilotos'}.` }, headers);
    }
    const currentYear = new Date().getUTCFullYear();
    const expiryYear = Number(String(license.data_validade || '').slice(0, 4)) || currentYear;
    const nextYear = Math.max(currentYear + 1, expiryYear + 1);
    const periodStart = `${nextYear}-01-01`;
    const periodEnd = `${nextYear}-12-31`;
    const renewal = await client.query(
      `INSERT INTO license_renewals
        (license_id,member_id,license_type,period_start,period_end,amount_due,currency,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING *`,
      [licenseId, license.piloto_id, type, periodStart, periodEnd, fee.amount, fee.currency, auth.sub],
    );
    const renewalId = renewal.rows[0].id;
    const created = await client.query(
      `INSERT INTO licencas
        (piloto_id,nome_completo,data_nascimento,numero_identificacao,endereco,nacionalidade,
         data_emissao,data_validade,nivel_certificacao,numero_horas_voo,escola_treinamento,
         assinatura_piloto,assinatura_instrutor,condicoes_medicas,apolice,tipo_cobertura,
         observacoes_especiais,numero_licenca,license_type,billing_status,renewal_id,created_by_user_id)
       SELECT piloto_id,nome_completo,data_nascimento,numero_identificacao,endereco,nacionalidade,
         $2,$3,nivel_certificacao,numero_horas_voo,escola_treinamento,assinatura_piloto,
         assinatura_instrutor,condicoes_medicas,apolice,tipo_cobertura,observacoes_especiais,
         numero_licenca,$4,'pending',$1,$5 FROM licencas WHERE id=$6 RETURNING *`,
      [renewalId, periodStart, periodEnd, type, auth.sub, licenseId],
    );
    await client.query('UPDATE license_renewals SET new_license_id=$1,updated_at=now() WHERE id=$2', [created.rows[0].id, renewalId]);
    await client.query('COMMIT');
    return send(res, 201, { data: { renewal: { ...renewal.rows[0], new_license_id: created.rows[0].id }, license: created.rows[0] }, error: null }, headers);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function updateLicenseRenewalStatus(req, res, headers, renewalId) {
  const auth = await requireActiveAdmin(req);
  const body = await jsonBody(req);
  const status = String(body.status || '').toLowerCase();
  if (!['paid', 'cancelled', 'waived'].includes(status)) return send(res, 422, { message: 'Estado de cobrança inválido.' }, headers);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const renewalResult = await client.query('SELECT * FROM license_renewals WHERE id=$1 FOR UPDATE', [renewalId]);
    const renewal = renewalResult.rows[0];
    if (!renewal) { await client.query('ROLLBACK'); return send(res, 404, { message: 'Cobrança não encontrada.' }, headers); }
    const amountPaid = status === 'paid' ? renewal.amount_due : 0;
    const updated = await client.query(
      `UPDATE license_renewals SET status=$1,amount_paid=$2,payment_method_id=COALESCE($3,payment_method_id),
         paid_at=CASE WHEN $1='paid' THEN now() ELSE NULL END,updated_at=now(),notes=COALESCE($4,notes)
       WHERE id=$5 RETURNING *`,
      [status, amountPaid, body.payment_method_id || null, body.notes || null, renewalId],
    );
    if (renewal.new_license_id) await client.query('UPDATE licencas SET billing_status=$1 WHERE id=$2', [status, renewal.new_license_id]);
    await client.query('COMMIT');
    return send(res, 200, { data: { ...updated.rows[0], updated_by: auth.sub }, error: null }, headers);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function updatePilotBookingStatus(req, res, headers, bookingId) {
  const auth = await authenticate(req);
  if (!['admin', 'pilot', 'provider', 'agent'].includes(auth.role)) return send(res, 403, { message: 'Operação não autorizada.' }, headers);
  const body = await jsonBody(req);
  const nextStatus = String(body.status || '');
  const allowedStatuses = ['confirmed', 'cancelled', 'completed'];
  if (!allowedStatuses.includes(nextStatus)) return send(res, 422, { message: 'Estado de reserva inválido.' }, headers);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query('SELECT id,provider_id,agent_id,status FROM bookings WHERE id=$1 FOR UPDATE', [bookingId]);
    const booking = currentResult.rows[0];
    if (!booking) { await client.query('ROLLBACK'); return send(res, 404, { message: 'Reserva não encontrada.' }, headers); }
    const ownsBooking = booking.provider_id === auth.sub || (auth.role === 'agent' && booking.agent_id === auth.sub);
    if (auth.role !== 'admin' && !ownsBooking) {
      await client.query('ROLLBACK');
      return send(res, 403, { message: 'Esta reserva não pertence ao utilizador autenticado.' }, headers);
    }
    const transitions = { pending: ['confirmed', 'cancelled'], confirmed: ['completed', 'cancelled'] };
    if (auth.role !== 'admin' && !(transitions[booking.status] || []).includes(nextStatus)) {
      await client.query('ROLLBACK');
      return send(res, 409, { message: `Não é possível alterar uma reserva ${booking.status} para ${nextStatus}.` }, headers);
    }
    const updated = await client.query('UPDATE bookings SET status=$1,updated_at=now() WHERE id=$2 RETURNING *', [nextStatus, bookingId]);
    await client.query('COMMIT');
    broadcastBookingChange(updated.rows[0], 'updated');
    return send(res, 200, { data: updated.rows[0], error: null }, headers);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function recoverPassword(req, res, headers) {
  const body = await jsonBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const result = await pool.query('SELECT id,email FROM platform_users WHERE lower(email)=lower($1)', [email]);
  const user = result.rows[0];
  if (user) {
    const raw = randomBytes(40).toString('base64url');
    const hash = createHash('sha256').update(raw).digest('hex');
    await pool.query('DELETE FROM platform_password_resets WHERE user_id=$1 OR expires_at<=now()', [user.id]);
    await pool.query(
      `INSERT INTO platform_password_resets (token_hash,user_id,expires_at)
       VALUES ($1,$2,now() + interval '30 minutes')`, [hash, user.id],
    );
    const resetUrl = `${frontendUrl}/reset-password?token=${encodeURIComponent(raw)}`;
    try {
      await sendEmail(
        user.email,
        'Redefinir palavra-passe — Parapente Angola',
        `<p>Recebemos um pedido para redefinir a sua palavra-passe.</p><p><a href="${resetUrl}">Criar nova palavra-passe</a></p><p>Este link expira em 30 minutos.</p>`,
        user.id,
      );
    } catch (error) {
      console.error('Failed to send password recovery email:', error.message);
    }
  }
  return send(res, 200, { data: {}, error: null }, headers);
}

async function changePassword(req, res, headers) {
  const body = await jsonBody(req);
  const password = String(body.password || '');
  if (password.length < 8) return send(res, 422, { message: 'A palavra-passe deve ter pelo menos 8 caracteres.' }, headers);
  let userId;
  let resetHash;
  if (body.reset_token) {
    resetHash = createHash('sha256').update(String(body.reset_token)).digest('hex');
    const result = await pool.query(
      'SELECT user_id FROM platform_password_resets WHERE token_hash=$1 AND expires_at>now()', [resetHash],
    );
    userId = result.rows[0]?.user_id;
  } else {
    userId = (await authenticate(req)).sub;
  }
  if (!userId) return send(res, 401, { message: 'O link de recuperação é inválido ou expirou.' }, headers);
  const passwordHash = await bcrypt.hash(password, 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE platform_users SET password_hash=$1,updated_at=now() WHERE id=$2', [passwordHash, userId]);
    await client.query('DELETE FROM platform_refresh_tokens WHERE user_id=$1', [userId]);
    if (resetHash) await client.query('DELETE FROM platform_password_resets WHERE token_hash=$1', [resetHash]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  return send(res, 200, { data: {}, error: null }, headers);
}

function restTable(pathname) {
  const match = /^\/rest\/v1\/([a-zA-Z0-9_]+)/.exec(pathname);
  return match?.[1] || '';
}

function ownerColumn(role, table) {
  if (table === 'profiles') return 'id';
  if (['membership_quotas', 'license_renewals'].includes(table)) return 'member_id';
  if (role === 'client') return ({
    activity_bookings: 'client_id', bookings: 'client_id', receipts: 'client_id',
  })[table] || '';
  if (['pilot', 'provider'].includes(role)) return ({
    bookings: 'provider_id', flight_logs: 'pilot_id', pilot_event_log: 'piloto_id',
  })[table] || '';
  if (role === 'agent') return ({
    bookings: 'agent_id', agent_clients: 'agent_id', agent_commission_rules: 'agent_id',
    agent_commissions: 'agent_id', flight_logs: 'pilot_id', pilot_event_log: 'piloto_id',
  })[table] || '';
  return '';
}

function scopedPayload(buffer, column, userId, table) {
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
    row[column] = userId;
    if (table === 'profiles') {
      for (const protectedField of ['role', 'status', 'verified', 'commission_percent']) delete row[protectedField];
    }
  }
  return Buffer.from(JSON.stringify(Array.isArray(parsed) ? rows : rows[0]));
}

async function verifyRelatedOwnership(role, table, buffer, userId) {
  let relation;
  if (role === 'client' && table === 'booking_extras') {
    relation = { source: 'booking_id', sql: 'SELECT id FROM bookings WHERE id = ANY($1::uuid[]) AND client_id = $2' };
  } else if (role === 'agent' && table === 'booking_extras') {
    relation = { source: 'booking_id', sql: 'SELECT id FROM bookings WHERE id = ANY($1::uuid[]) AND agent_id = $2' };
  } else if (['pilot', 'provider', 'agent'].includes(role) && table === 'flight_evaluations') {
    relation = { source: 'flight_log_id', sql: 'SELECT id FROM flight_logs WHERE id = ANY($1::uuid[]) AND pilot_id = $2' };
  } else {
    return;
  }
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const ids = [...new Set(rows.map((row) => row?.[relation.source]).filter(Boolean))];
  if (!ids.length) throw Object.assign(new Error('Operação não autorizada.'), { status: 403 });
  const result = await pool.query(relation.sql, [ids, userId]);
  if (result.rowCount !== ids.length) throw Object.assign(new Error('Operação não autorizada.'), { status: 403 });
}

async function verifyAgentBookingClients(buffer, agentId) {
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const clientIds = [...new Set(rows.map((row) => row?.client_id).filter(Boolean))];
  if (!clientIds.length) throw Object.assign(new Error('Selecione um cliente da sua carteira.'), { status: 422 });
  const result = await pool.query(
    'SELECT client_id FROM agent_clients WHERE agent_id=$1 AND client_id=ANY($2::uuid[])',
    [agentId, clientIds],
  );
  if (result.rowCount !== clientIds.length) {
    throw Object.assign(new Error('O cliente selecionado não pertence à carteira deste agente.'), { status: 403 });
  }
}

function rejectAgentPilotAssignment(buffer) {
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.some((row) => row && Object.hasOwn(row, 'provider_id'))) {
    throw Object.assign(new Error('Agentes não podem atribuir pilotos às reservas.'), { status: 403 });
  }
}

async function getAgentOverview(req, res, headers) {
  const auth = await authenticate(req);
  if (auth.role !== 'agent') return send(res, 403, { message: 'Área reservada a agentes.' }, headers);
  const profileResult = await pool.query('SELECT status FROM profiles WHERE id=$1 AND role=$2', [auth.sub, 'agent']);
  if (profileResult.rows[0]?.status !== 'active') return send(res, 403, { message: 'Agente inativo ou suspenso.' }, headers);

  const [bookings, clients, commissions, rules, receipts, paymentMethods] = await Promise.all([
    pool.query(
      `SELECT b.*,cp.name AS client_name,cp.phone AS client_phone,l.name AS location_name,
              a.name AS activity_name,pp.name AS provider_name
       FROM bookings b
       LEFT JOIN profiles cp ON cp.id=b.client_id
       LEFT JOIN flight_zones l ON l.id=b.location_id
       LEFT JOIN activities a ON a.id=b.activity_id
       LEFT JOIN profiles pp ON pp.id=b.provider_id
       WHERE b.agent_id=$1 ORDER BY b.booking_date DESC,b.booking_time DESC LIMIT 250`,
      [auth.sub],
    ),
    pool.query(
      `SELECT p.id,p.name,p.phone,p.nif,p.status,u.email,ac.created_at
       FROM agent_clients ac JOIN profiles p ON p.id=ac.client_id
       LEFT JOIN platform_users u ON u.id=p.id
       WHERE ac.agent_id=$1 ORDER BY p.name`,
      [auth.sub],
    ),
    pool.query(
      `SELECT c.*,b.booking_code,b.booking_date,b.status,l.name AS location_name,a.name AS activity_name
       FROM agent_commissions c JOIN bookings b ON b.id=c.booking_id
       LEFT JOIN flight_zones l ON l.id=b.location_id
       LEFT JOIN activities a ON a.id=b.activity_id
       WHERE c.agent_id=$1 ORDER BY b.booking_date DESC LIMIT 500`,
      [auth.sub],
    ),
    pool.query(
      `SELECT r.*,l.name AS location_name,a.name AS activity_name
       FROM agent_commission_rules r
       LEFT JOIN flight_zones l ON r.scope_type='location' AND l.id=r.scope_id
       LEFT JOIN activities a ON r.scope_type='activity' AND a.id=r.scope_id
       WHERE r.agent_id=$1 ORDER BY r.scope_type,r.created_at`,
      [auth.sub],
    ),
    pool.query(
      `SELECT r.id,r.client_id,r.issue_date,r.total_amount,r.status,p.name AS client_name,
              COALESCE(SUM(rp.amount) FILTER (WHERE rp.type='payment'),0) AS paid_amount,
              COALESCE(SUM(rp.amount) FILTER (WHERE rp.type='refund'),0) AS refunded_amount,
              STRING_AGG(DISTINCT b.booking_code, ', ') AS booking_codes
       FROM receipts r JOIN profiles p ON p.id=r.client_id
       LEFT JOIN receipt_payments rp ON rp.receipt_id=r.id
       LEFT JOIN receipt_items ri ON ri.receipt_id=r.id
       LEFT JOIN bookings b ON b.id=ri.booking_id
       WHERE r.agent_id=$1
       GROUP BY r.id,p.name ORDER BY r.issue_date DESC,r.created_at DESC`,
      [auth.sub],
    ),
    pool.query('SELECT id,name FROM payment_methods WHERE is_active=true ORDER BY name'),
  ]);
  return send(res, 200, { data: {
    bookings: bookings.rows,
    clients: clients.rows,
    commissions: commissions.rows,
    rules: rules.rows,
    receipts: receipts.rows,
    paymentMethods: paymentMethods.rows,
  }, error: null }, headers);
}

async function manageAgentReceipt(req, res, headers) {
  const auth = await authenticate(req);
  if (auth.role !== 'agent') return send(res, 403, { message: 'Área reservada a agentes.' }, headers);
  const body = await jsonBody(req);
  const bookingId = String(body.booking_id || '');
  const paymentAmount = body.payment_amount === undefined || body.payment_amount === '' ? 0 : Number(body.payment_amount);
  const paymentMethodId = body.payment_method_id ? String(body.payment_method_id) : null;
  if (!/^[0-9a-f-]{36}$/i.test(bookingId) || !Number.isFinite(paymentAmount) || paymentAmount < 0) {
    return send(res, 422, { message: 'Reserva ou valor de pagamento inválido.' }, headers);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bookingResult = await client.query(
      `SELECT b.id,b.client_id,b.total_price,b.payment_status,b.booking_code
       FROM bookings b JOIN agent_clients ac ON ac.client_id=b.client_id AND ac.agent_id=b.agent_id
       WHERE b.id=$1 AND b.agent_id=$2 FOR UPDATE OF b`,
      [bookingId, auth.sub],
    );
    const booking = bookingResult.rows[0];
    if (!booking) { await client.query('ROLLBACK'); return send(res, 404, { message: 'Reserva não encontrada na carteira do agente.' }, headers); }

    let receiptResult = await client.query(
      `SELECT r.* FROM receipts r JOIN receipt_items ri ON ri.receipt_id=r.id
       WHERE ri.booking_id=$1 AND r.agent_id=$2 ORDER BY r.created_at LIMIT 1 FOR UPDATE OF r`,
      [bookingId, auth.sub],
    );
    let receipt = receiptResult.rows[0];
    if (!receipt) {
      receiptResult = await client.query(
        `INSERT INTO receipts(client_id,issue_date,total_amount,status,agent_id)
         VALUES ($1,CURRENT_DATE,$2,'pending',$3) RETURNING *`,
        [booking.client_id, Number(booking.total_price || 0), auth.sub],
      );
      receipt = receiptResult.rows[0];
      await client.query(
        `INSERT INTO receipt_items(receipt_id,booking_id,description,amount)
         VALUES ($1,$2,'Reserva ' || $3,$4)`,
        [receipt.id, bookingId, booking.booking_code || bookingId.slice(0, 8).toUpperCase(), Number(booking.total_price || 0)],
      );
    }

    if (paymentAmount > 0) {
      const methodResult = await client.query('SELECT id FROM payment_methods WHERE id=$1 AND is_active=true', [paymentMethodId]);
      if (!methodResult.rows[0]) { await client.query('ROLLBACK'); return send(res, 422, { message: 'Selecione um método de pagamento válido.' }, headers); }
      await client.query(
        `INSERT INTO receipt_payments(receipt_id,payment_method_id,amount,payment_date,type,notes)
         VALUES ($1,$2,$3,CURRENT_DATE,'payment',$4)`,
        [receipt.id, paymentMethodId, paymentAmount, String(body.notes || '').slice(0, 500) || null],
      );
    }

    const totals = await client.query(
      `SELECT COALESCE(SUM(CASE WHEN type='refund' THEN -amount ELSE amount END),0) AS paid
       FROM receipt_payments WHERE receipt_id=$1`,
      [receipt.id],
    );
    const paid = Number(totals.rows[0].paid || 0);
    const total = Number(receipt.total_amount || 0);
    const status = paid >= total && total > 0 ? 'paid' : (paid > 0 ? 'partial' : 'pending');
    await client.query('UPDATE receipts SET status=$1 WHERE id=$2', [status, receipt.id]);
    await client.query('UPDATE bookings SET payment_status=$1,updated_at=now() WHERE id=$2', [status === 'pending' ? 'unpaid' : status, bookingId]);
    await client.query('COMMIT');
    return send(res, 200, { data: { receipt_id: receipt.id, status, paid_amount: paid, total_amount: total }, error: null }, headers);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function proxyRest(req, res, url, headers) {
  const table = restTable(url.pathname);
  const auth = await authenticate(req, req.method === 'GET' || req.method === 'HEAD');
  const role = auth ? normalizeRole(auth.role) : 'anon';
  const isRpc = url.pathname.startsWith('/rest/v1/rpc/');
  const rpcName = isRpc ? url.pathname.slice('/rest/v1/rpc/'.length).split('/')[0] : '';
  const read = req.method === 'GET' || req.method === 'HEAD';
  const allowed = (isRpc && (
    role === 'admin'
    || publicRpcs.has(rpcName)
    || (role !== 'anon' && authenticatedRpcs.has(rpcName))
    || (['pilot', 'provider', 'agent'].includes(role) && pilotRpcs.has(rpcName))
  )) || (!isRpc && (role === 'admin'
    || (read && (publicReadTables.has(table) || (role !== 'anon' && (!agentSensitiveTables.has(table) || ['admin', 'agent'].includes(role)))))
    || (!read && role === 'client' && clientWriteTables.has(table))
    || (!read && ['pilot', 'student', 'aluno', 'provider'].includes(role) && pilotWriteTables.has(table))
    || (!read && role === 'agent' && agentWriteTables.has(table))));
  if (!allowed) return send(res, auth ? 403 : 401, { message: 'Operação não autorizada.' }, headers);

  const scopeColumn = auth && role !== 'admin' ? ownerColumn(role, table) : '';
  if (scopeColumn && read) url.searchParams.set(scopeColumn, `eq.${auth.sub}`);

  const upstreamHeaders = {};
  for (const key of ['content-type', 'prefer', 'range', 'accept', 'accept-profile', 'content-profile']) {
    if (req.headers[key]) upstreamHeaders[key] = req.headers[key];
  }
  upstreamHeaders.Authorization = `Bearer ${required('POSTGREST_SERVICE_TOKEN', 32)}`;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let requestBody = Buffer.concat(chunks);
  if (auth && role !== 'admin' && !read && !isRpc) {
    if (role === 'agent' && table === 'bookings' && req.method === 'POST') {
      await verifyAgentBookingClients(requestBody, auth.sub);
    }
    if (role === 'agent' && table === 'bookings' && ['POST', 'PATCH', 'PUT'].includes(req.method)) rejectAgentPilotAssignment(requestBody);
    if (scopeColumn) {
      if (req.method !== 'POST') url.searchParams.set(scopeColumn, `eq.${auth.sub}`);
      requestBody = scopedPayload(requestBody, scopeColumn, auth.sub, table);
    } else {
      await verifyRelatedOwnership(role, table, requestBody, auth.sub);
    }
  }
  const response = await fetch(`${postgrestUrl}${url.pathname.replace('/rest/v1', '')}${url.search}`, {
    method: req.method, headers: upstreamHeaders,
    body: read ? undefined : requestBody,
  });
  const responseHeaders = { ...headers };
  for (const key of ['content-type', 'content-range', 'preference-applied']) {
    const value = response.headers.get(key); if (value) responseHeaders[key] = value;
  }
  const responseBuffer = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, responseHeaders);
  res.end(responseBuffer);
  if (response.ok && table === 'bookings' && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    try {
      const payload = responseBuffer.length ? JSON.parse(responseBuffer.toString('utf8')) : [];
      const rows = Array.isArray(payload) ? payload : [payload];
      for (const booking of rows.filter((row) => row?.id)) {
        const action = req.method === 'POST' ? 'created' : req.method === 'DELETE' ? 'deleted' : 'updated';
        broadcastBookingChange(booking, action);
      }
    } catch (error) {
      console.error('Failed to publish booking event:', error.message);
    }
  }
}

async function importRows(req, res, headers) {
  if (!migrationToken || req.headers['x-migration-token'] !== migrationToken) {
    return send(res, 404, { message: 'Not found' }, headers);
  }
  const body = await jsonBody(req, 8_000_000);
  const table = String(body.table || '');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!importTables.has(table) || !rows.length || rows.length > 500) {
    return send(res, 422, { message: 'Invalid import batch' }, headers);
  }
  const columns = Object.keys(rows[0]);
  if (!columns.length || columns.some((column) => !/^[a-z_][a-z0-9_]*$/i.test(column))) {
    return send(res, 422, { message: 'Invalid columns' }, headers);
  }
  const values = [];
  const tuples = rows.map((row, rowIndex) => {
    if (Object.keys(row).join('|') !== columns.join('|')) throw Object.assign(new Error('Inconsistent import columns'), { status: 422 });
    return `(${columns.map((_, columnIndex) => {
      values.push(row[columns[columnIndex]]); return `$${rowIndex * columns.length + columnIndex + 1}`;
    }).join(',')})`;
  });
  const quoted = columns.map((column) => `"${column}"`).join(',');
  await pool.query(`INSERT INTO "${table}" (${quoted}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, values);
  return send(res, 200, { imported: rows.length, table }, headers);
}

async function initializeDatabase() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const directory = new URL('../db/', import.meta.url);
      const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
      await pool.query(`CREATE TABLE IF NOT EXISTS platform_schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const [{ rows: migrationRows }, { rows: initializedRows }] = await Promise.all([
        pool.query('SELECT filename FROM platform_schema_migrations'),
        pool.query("SELECT to_regclass('public.platform_users') IS NOT NULL AND to_regclass('public.profiles') IS NOT NULL AS initialized"),
      ]);
      const applied = new Set(migrationRows.map((row) => row.filename));
      if (!applied.size && initializedRows[0]?.initialized) {
        for (const file of files) {
          await pool.query('INSERT INTO platform_schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
          applied.add(file);
        }
      }
      for (const file of files) {
        if (applied.has(file)) continue;
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(await readFile(new URL(file, directory), 'utf8'));
          await client.query('INSERT INTO platform_schema_migrations (filename) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
      await pool.query("NOTIFY pgrst, 'reload schema'");
      return;
    }
    catch (error) {
      if (attempt === 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

await initializeDatabase();

http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const headers = corsHeaders(origin);
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
  if (origin && !headers['Access-Control-Allow-Origin']) return send(res, 403, { message: 'Origin not allowed' }, headers);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok', service: 'parapente-angola-api' }, headers);
    if (req.method === 'POST' && url.pathname === '/functions/meteoblue') return await getWeatherForecast(req, res, headers);
    if (req.method === 'GET' && url.pathname === '/events/bookings') return await streamBookingEvents(req, res, headers);
    if (req.method === 'POST' && url.pathname === '/auth/signup') return await signUp(req, res, headers);
    if (req.method === 'POST' && url.pathname === '/auth/signup/verify') return await verifySignUp(req, res, headers);
    if (req.method === 'POST' && url.pathname === '/auth/token') return await signIn(req, res, headers);
    if (req.method === 'POST' && url.pathname === '/auth/refresh') return await refresh(req, res, headers);
    if (req.method === 'GET' && url.pathname === '/auth/user') return await currentUser(req, res, headers);
    if (req.method === 'POST' && url.pathname === '/auth/recover') return await recoverPassword(req, res, headers);
    if (req.method === 'POST' && url.pathname === '/auth/password') return await changePassword(req, res, headers);
    if (req.method === 'POST' && url.pathname === '/bookings/guest') return await createGuestBooking(req, res, headers);
    if (req.method === 'POST' && (url.pathname === '/admin/users' || url.pathname === '/functions/createClient')) return await createManagedUser(req, res, headers);
    if (req.method === 'POST' && url.pathname === '/admin/licenses/renew') return await renewLicense(req, res, headers);
    const licenseRenewalStatusMatch = /^\/admin\/license-renewals\/([0-9a-f-]{36})\/status$/.exec(url.pathname);
    if (licenseRenewalStatusMatch && req.method === 'PATCH') return await updateLicenseRenewalStatus(req, res, headers, licenseRenewalStatusMatch[1]);
    if (req.method === 'GET' && url.pathname === '/agent/overview') return await getAgentOverview(req, res, headers);
    if (req.method === 'POST' && url.pathname === '/agent/receipts') return await manageAgentReceipt(req, res, headers);
    const pilotBookingStatusMatch = /^\/pilot\/bookings\/([0-9a-f-]{36})\/status$/.exec(url.pathname);
    if (pilotBookingStatusMatch && req.method === 'PATCH') return await updatePilotBookingStatus(req, res, headers, pilotBookingStatusMatch[1]);
    const xcontestPilotMatch = /^\/integrations\/xcontest\/pilots\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (xcontestPilotMatch && req.method === 'GET') return await getXContestPilot(req, res, headers, xcontestPilotMatch[1]);
    if (xcontestPilotMatch && req.method === 'PUT') return await saveXContestPilot(req, res, headers, xcontestPilotMatch[1]);
    const publicLicenseMatch = /^\/licenses\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (publicLicenseMatch && req.method === 'GET') return await getPublicLicense(req, res, headers, publicLicenseMatch[1]);
    const xcontestImportMatch = /^\/integrations\/xcontest\/pilots\/([0-9a-f-]{36})\/flights\/igc$/.exec(url.pathname);
    if (xcontestImportMatch && req.method === 'POST') return await importIgcFlight(req, res, headers, xcontestImportMatch[1]);
    const xcontestDeleteMatch = /^\/integrations\/xcontest\/pilots\/([0-9a-f-]{36})\/flights\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (xcontestDeleteMatch && req.method === 'DELETE') return await deleteIgcFlight(req, res, headers, xcontestDeleteMatch[1], xcontestDeleteMatch[2]);
    if (req.method === 'POST' && url.pathname === '/internal/import') return await importRows(req, res, headers);
    if (url.pathname.startsWith('/rest/v1/')) return await proxyRest(req, res, url, headers);
    return send(res, 404, { message: 'Not found' }, headers);
  } catch (error) {
    console.error(error);
    return send(res, error.status || 500, { message: error.status ? error.message : 'Internal server error' }, headers);
  }
}).listen(port, '0.0.0.0', () => console.log(`Parapente Angola API listening on ${port}`));
