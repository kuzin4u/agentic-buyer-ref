// Канал mTLS к ПАО (Р64 п. 5): свой fetch поверх node:https, без undici и других зависимостей. Ключ TLS и сертификат
// канала загружаются здесь и остаются в замыкании (инвариант 2): наружу — только функция fetch и срок сертификата.
// Доверие — только закреплённому корню УЦ песочницы (п. 6), TLS 1.3 и только он, без возобновления сессии (#88 п. 3),
// проверка имени сервера не отключается (#88 п. 1). Классификация ошибок канала — в адаптере ПАО (п. 7, К3.2).
import { Agent, request } from "node:https";
import { TlsCertExpired, TlsCertMissing } from "./errors.js";
import { loadTlsCertificate, loadTlsKey, type TlsRoot } from "./tls.js";

export interface TlsChannelOptions {
  readonly root: TlsRoot;
  readonly now?: () => Date;
}

/** Канал: fetch для адаптеров ПАО и срок сертификата (открытые сведения). */
export interface TlsChannel {
  readonly fetch: typeof fetch;
  readonly notAfter: Date;
}

/** Статусы без тела (Fetch, «null body status»): Response с телом для них не строится. */
const NULL_BODY = new Set([101, 204, 205, 304]);

function bodyOf(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new TypeError("канал mTLS: тело обращения — только строка или байты");
}

/**
 * Канал из каталога ключей: ключ TLS (`loadTlsKey`) и сертификат (`loadTlsCertificate`); сертификата нет —
 * TlsCertMissing, срок истёк — TlsCertExpired (и здесь, и перед каждым обращением, до сети). Каждое обращение —
 * своё подключение с полным рукопожатием; редиректы не выполняются (ответ 3xx отдаётся как есть — `redirect: "manual"`).
 */
export function tlsChannel(dir: string, o: TlsChannelOptions): TlsChannel {
  const now = o.now ?? (() => new Date());
  const cert = loadTlsCertificate(dir);
  if (cert === null) throw new TlsCertMissing();
  const notAfter = new Date(cert.validTo);
  const expired = () => now().getTime() >= notAfter.getTime();
  if (expired()) throw new TlsCertExpired();
  const agent = new Agent({
    key: loadTlsKey(dir).export({ type: "pkcs8", format: "pem" }),
    cert: cert.toString(),
    ca: o.root.pem,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    maxCachedSessions: 0,
  });
  const channelFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (expired()) throw new TlsCertExpired();
    if (input instanceof Request) throw new TypeError("канал mTLS: обращение — адрес и init, не Request");
    const url = new URL(input);
    if (url.protocol !== "https:") throw new TypeError("канал mTLS: только https");
    const body = bodyOf(init?.body);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    if (body !== undefined) headers["content-length"] = String(body.length);
    return new Promise<Response>((resolve, reject) => {
      const req = request(url, { method: init?.method ?? "GET", headers, agent, ...(init?.signal && { signal: init.signal }) }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, x);
          }
          const status = res.statusCode ?? 0;
          resolve(new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage ?? "", headers: out }));
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  };
  return Object.freeze({ fetch: channelFetch as typeof fetch, notAfter });
}
