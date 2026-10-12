// Live chat support. Users write to the team and admins reply from the admin panel.
// "Online" means an admin has opened the support area in the last 5 minutes. When nobody is
// online, the user's message is still saved and the user gets a notification when it is answered.
const ONLINE_MS = 5 * 60_000;
let adminSeenAt = 0;

export function mountSupport(app, d) {
  const { auth, admin, h, q, httpErr, notifyUser, pushStaff } = d;

  async function openThread(uid) {
    return (await q(`SELECT id FROM support_threads WHERE user_id=$1 AND status='open' ORDER BY id DESC LIMIT 1`, [uid])).rows[0];
  }

  async function messagesOf(threadId) {
    const rows = (await q(
      `SELECT id, sender, body, created_at FROM support_messages WHERE thread_id=$1 ORDER BY id DESC LIMIT 100`, [threadId])).rows;
    return rows.reverse().map((m) => ({ id: Number(m.id), from: m.sender, body: m.body, at: m.created_at }));
  }

  // ---------- user side ----------
  app.get('/support', auth, h(async (req, res) => {
    const t = await openThread(req.uid);
    res.json({
      online: Date.now() - adminSeenAt < ONLINE_MS,
      messages: t ? await messagesOf(t.id) : [],
    });
  }));

  app.post('/support/messages', auth, h(async (req, res) => {
    const body = String(req.body?.body || '').trim().slice(0, 500);
    if (!body) throw httpErr(400, 'Type your message first');
    const recent = (await q(
      `SELECT COUNT(*) AS n FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
       WHERE t.user_id=$1 AND m.sender='user' AND m.created_at > now() - interval '1 minute'`, [req.uid])).rows[0].n;
    if (Number(recent) >= 10) throw httpErr(429, 'Too many messages. Wait a minute and try again.');
    let t = await openThread(req.uid);
    if (!t) t = (await q(`INSERT INTO support_threads(user_id) VALUES($1) RETURNING id`, [req.uid])).rows[0];
    await q(`INSERT INTO support_messages(thread_id, sender, body) VALUES($1,'user',$2)`, [t.id, body]);
    await q(`UPDATE support_threads SET updated_at=now() WHERE id=$1`, [t.id]);
    if (pushStaff) pushStaff({ title: 'New live chat message', body: body.slice(0, 120), url: '/' }).catch((e) => console.error('staff push failed', e.message));
    res.status(201).json({ ok: true, online: Date.now() - adminSeenAt < ONLINE_MS });
  }));

  // ---------- admin side (the admin middleware checks ADMIN_EMAIL on every call) ----------
  app.get('/admin/support', admin, h(async (_req, res) => {
    adminSeenAt = Date.now();
    const rows = (await q(
      `SELECT t.id, t.updated_at, u.full_name, u.phone,
         (SELECT body FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_body,
         (SELECT sender FROM support_messages m WHERE m.thread_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_sender
       FROM support_threads t JOIN users u ON u.id = t.user_id
       WHERE t.status='open' ORDER BY t.updated_at DESC LIMIT 50`)).rows;
    res.json(rows.map((r) => ({
      id: Number(r.id), name: r.full_name, phone: r.phone, at: r.updated_at, lastBody: r.last_body, lastSender: r.last_sender,
    })));
  }));

  app.get('/admin/support/:id', admin, h(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw httpErr(404, 'Chat not found');
    const t = (await q('SELECT id FROM support_threads WHERE id=$1', [req.params.id])).rows[0];
    if (!t) throw httpErr(404, 'Chat not found');
    adminSeenAt = Date.now();
    res.json({ id: Number(t.id), messages: await messagesOf(t.id) });
  }));

  app.post('/admin/support/:id/reply', admin, h(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw httpErr(404, 'Chat not found');
    const body = String(req.body?.body || '').trim().slice(0, 500);
    if (!body) throw httpErr(400, 'Type a reply first');
    const t = (await q(`SELECT id, user_id FROM support_threads WHERE id=$1 AND status='open'`, [req.params.id])).rows[0];
    if (!t) throw httpErr(404, 'Chat not found or already closed');
    await q(`INSERT INTO support_messages(thread_id, sender, body) VALUES($1,'admin',$2)`, [t.id, body]);
    await q(`UPDATE support_threads SET updated_at=now() WHERE id=$1`, [t.id]);
    adminSeenAt = Date.now();
    notifyUser(t.user_id, 'Support replied', 'Our team replied in your live chat. Open Help to read it.');
    res.json({ ok: true });
  }));

  app.post('/admin/support/:id/close', admin, h(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) throw httpErr(404, 'Chat not found');
    await q(`UPDATE support_threads SET status='closed', updated_at=now() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  }));
}
