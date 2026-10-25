// Изменяющее обращение к ПАО стенда без Idempotency-Key — только для П24 (Р56 п. 1; решение владельца к КТ1): подпись —
// порт подписи агента, как у клиента ПАО (ПАО §2), ключа идемпотентности нет. В src такой возможности нет: клиент ПАО
// агента без ключа обращение не отправляет (`keyOf`, AGENT_REQUEST_DEFECT, adapters/pao); тест графа импортов —
// только второй рубеж: этот модуль подключает только tests/scenarios/p24.test.ts. В журнале обращений — тестовая
// поддержка (source "test", user-agent `INJECT_AGENT`), не агент (ревью КТ1 Р56 № 4).
import { randomUUID } from "node:crypto";
import { signRequest } from "@kuzin4u/agentic-core";
import { INJECT_AGENT, type Contour } from "./contour.js";

/** `at` — время подписи (x-timestamp): часы, которые сверяет стенд; у контура с подставленными часами — их значение
 *  (ревью КТ1 Р56 № 5). */
export async function unkeyedPost(c: Contour, path: string, body: unknown, at: Date): Promise<{ status: number; body: unknown }> {
  const { baseUrl, signing } = c.paoAccess!;
  const text = JSON.stringify(body);
  const signed = signRequest(
    {
      method: "POST",
      path,
      query: "",
      headers: {
        "content-type": "application/json",
        "x-agent-code": c.agentCode,
        "x-timestamp": at.toISOString().slice(0, 19) + "Z",
        "x-nonce": randomUUID(),
      },
      body: text,
    },
    signing.current(),
  );
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { ...signed.headers, "user-agent": INJECT_AGENT }, body: text });
  const out = await res.text();
  return { status: res.status, body: out === "" ? undefined : (JSON.parse(out) as unknown) };
}
