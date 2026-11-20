const FROM = "小账本 <noreply@ledger.lofla.at>";
const CURS = ["EUR", "USD", "CNY", "GBP", "JPY", "HKD", "CHF"];
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};
const J = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "content-type": "application/json; charset=utf-8" } });
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const rnd = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); };
const code6 = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(a[0] % 1000000).padStart(6, "0"); };

async function limit(env, key, max, win) {
  const now = Date.now();
  const r = await env.DB.prepare("SELECT w,c FROM rl WHERE k=?").bind(key).first();
  if (!r || now - r.w >= win) {
    await env.DB.prepare("INSERT INTO rl(k,w,c) VALUES(?,?,1) ON CONFLICT(k) DO UPDATE SET w=excluded.w,c=1").bind(key, now).run();
    return true;
  }
  if (r.c >= max) return false;
  await env.DB.prepare("UPDATE rl SET c=c+1 WHERE k=?").bind(key).run();
  return true;
}

async function sendMail(env, to, code) {
  const res = await fetch(env.MAIL_URL || "https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: "小账本登录验证码：" + code,
      text: "你的小账本登录验证码是 " + code + "，10 分钟内有效。\n如果不是你本人操作，请忽略这封邮件。",
    }),
  });
  return res.ok;
}

async function authRequest(req, env) {
  const b = await req.json().catch(() => ({}));
  const email = String(b.email || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return J({ error: "邮箱格式不正确" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "?";
  if (!(await limit(env, "cd:" + email, 1, 60000))) return J({ error: "请 60 秒后再获取验证码" }, 429);
  if (!(await limit(env, "ip:" + ip, 20, 3600000)) || !(await limit(env, "em:" + email, 5, 3600000)))
    return J({ error: "请求太频繁，请稍后再试" }, 429);
  const code = code6(), salt = rnd(8);
  const hash = await sha(code + ":" + email + ":" + salt);
  await env.DB.prepare(
    "INSERT INTO otp(email,code_hash,salt,expires,attempts) VALUES(?,?,?,?,0) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,salt=excluded.salt,expires=excluded.expires,attempts=0"
  ).bind(email, hash, salt, Date.now() + 600000).run();
  if (!(await sendMail(env, email, code))) return J({ error: "邮件发送失败，请稍后重试" }, 502);
  return J({ ok: true });
}

async function authVerify(req, env) {
  const b = await req.json().catch(() => ({}));
  const email = String(b.email || "").trim().toLowerCase();
  const code = String(b.code || "").trim();
  if (!email || !/^\d{6}$/.test(code)) return J({ error: "验证码格式不正确" }, 400);
  if (!(await limit(env, "vf:" + email, 10, 600000))) return J({ error: "尝试次数过多，请稍后再试" }, 429);
  const r = await env.DB.prepare("SELECT * FROM otp WHERE email=?").bind(email).first();
  if (!r || r.expires < Date.now() || r.attempts >= 5) return J({ error: "验证码已失效，请重新获取" }, 400);
  if ((await sha(code + ":" + email + ":" + r.salt)) !== r.code_hash) {
    await env.DB.prepare("UPDATE otp SET attempts=attempts+1 WHERE email=?").bind(email).run();
    return J({ error: "验证码不正确" }, 400);
  }
  await env.DB.prepare("DELETE FROM otp WHERE email=?").bind(email).run();
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO users(email,created_at) VALUES(?,?)").bind(email, now).run();
  const u = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
  const token = rnd(32);
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,created_at,expires) VALUES(?,?,?,?)")
    .bind(await sha(token), u.id, now, now + 400 * 864e5).run();
  return J({ token, email });
}

async function session(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer ([0-9a-f]{64})$/);
  if (!m) return null;
  const h = await sha(m[1]);
  const s = await env.DB.prepare("SELECT user_id,expires FROM sessions WHERE token_hash=?").bind(h).first();
  if (!s || s.expires < Date.now()) return null;
  return { uid: s.user_id, hash: h };
}

const UPSERT =
  "INSERT INTO records(user_id,id,type,amount,cat,pay,cur,date,note,updated_at,deleted,srv_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) " +
  "ON CONFLICT(user_id,id) DO UPDATE SET type=excluded.type,amount=excluded.amount,cat=excluded.cat,pay=excluded.pay,cur=excluded.cur," +
  "date=excluded.date,note=excluded.note,updated_at=excluded.updated_at,deleted=excluded.deleted,srv_ts=excluded.srv_ts " +
  "WHERE excluded.updated_at>records.updated_at";

const str = (v, n) => String(v == null ? "" : v).slice(0, n);

async function sync(req, env, uid) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return J({ error: "请求格式错误" }, 400);
  const now = Date.now();
  const stmts = [];
  let i = 0;
  for (const r of (Array.isArray(b.records) ? b.records : []).slice(0, 100)) {
    const id = String(r && r.id != null ? r.id : "");
    if (!/^\d{1,20}$/.test(id)) continue;
    let ut = Number(r.updated_at) || now;
    if (ut > now + 864e5) ut = now;
    const ts = now * 1000 + i++;
    if (r.deleted) {
      stmts.push(env.DB.prepare(UPSERT).bind(uid, id, null, null, null, null, null, null, null, ut, 1, ts));
      continue;
    }
    const amount = Number(r.amount);
    if (!(amount >= 0 && amount < 1e12)) continue;
    if (r.type !== "in" && r.type !== "out") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date))) continue;
    const cur = CURS.includes(r.cur) ? r.cur : "EUR";
    stmts.push(env.DB.prepare(UPSERT).bind(uid, id, r.type, amount, str(r.cat, 40), str(r.pay, 40), cur, r.date, str(r.note, 200), ut, 0, ts));
  }
  if (b.settings && typeof b.settings === "object") {
    const data = JSON.stringify(b.settings.data || {});
    const ut = Math.min(Number(b.settings.updated_at) || now, now + 864e5);
    if (data.length <= 20000)
      stmts.push(
        env.DB.prepare(
          "INSERT INTO settings(user_id,data,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at WHERE excluded.updated_at>settings.updated_at"
        ).bind(uid, data, ut)
      );
  }
  if (stmts.length) await env.DB.batch(stmts);

  const out = { ok: true, now };
  if (b.since != null) {
    const since = Number(b.since) || 0;
    const { results } = await env.DB.prepare(
      "SELECT id,type,amount,cat,pay,cur,date,note,updated_at,deleted,srv_ts FROM records WHERE user_id=? AND srv_ts>? ORDER BY srv_ts LIMIT 500"
    ).bind(uid, since).all();
    out.records = results.map((x) => ({ ...x, deleted: !!x.deleted }));
    out.more = results.length === 500;
    out.cursor = results.length ? results[results.length - 1].srv_ts : since;
    const s = await env.DB.prepare("SELECT data,updated_at FROM settings WHERE user_id=?").bind(uid).first();
    out.settings = s ? { data: JSON.parse(s.data), updated_at: s.updated_at } : null;
  }
  return J(out);
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const path = new URL(req.url).pathname;
    try {
      if (req.method === "GET" && (path === "/" || path === "/health")) return J({ ok: true });
      if (req.method !== "POST") return J({ error: "not found" }, 404);
      if (path === "/auth/request") return await authRequest(req, env);
      if (path === "/auth/verify") return await authVerify(req, env);
      const s = await session(req, env);
      if (!s) return J({ error: "未登录或登录已过期" }, 401);
      if (path === "/sync") return await sync(req, env, s.uid);
      if (path === "/auth/logout") {
        await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(s.hash).run();
        return J({ ok: true });
      }
      if (path === "/account/delete") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM records WHERE user_id=?").bind(s.uid),
          env.DB.prepare("DELETE FROM settings WHERE user_id=?").bind(s.uid),
          env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(s.uid),
          env.DB.prepare("DELETE FROM users WHERE id=?").bind(s.uid),
        ]);
        return J({ ok: true });
      }
      return J({ error: "not found" }, 404);
    } catch (e) {
      return J({ error: "服务器错误" }, 500);
    }
  },
};
