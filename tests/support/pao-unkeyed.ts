// Изменяющее обращение к ПАО стенда без Idempotency-Key — только для П24 (Р56 п. 1; решение владельца к КТ1): подпись —
// порт подписи агента, как у клиента ПАО (ПАО §2), ключа идемпотентности нет. В src такой возможности нет: клиент ПАО
// агента без ключа обращение не отправляет (AGENT_REQUEST_DEFECT, adapters/pao); граница — тест графа импортов
// (этот модуль подключает только tests/scenarios/p24.test.ts).
import { randomUUID } from "node:crypto";
import { signRequest } from "@kuzin4u/agentic-core";
import type { Contour } from "./contour.js";

export async function unkeyedPost(c: Contour, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
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
        "x-timestamp": new Date().toISOString().slice(0, 19) + "Z", // системные часы, как у клиента ПАО
        "x-nonce": randomUUID(),
      },
      body: text,
    },
    signing.current(),
  );
  const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: signed.headers, body: text });
  const out = await res.text();
  return { status: res.status, body: out === "" ? undefined : (JSON.parse(out) as unknown) };
}
