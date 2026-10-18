# Источник копии ПАО

Владелец протокола — репозиторий Платформы (`agentic-ps-platform`, РП7). Здесь — копия фиксированной версии; вручную не правится.

| Файл | Версия | Источник | Коммит | sha-256 |
|---|---|---|---|---|
| `agent-protocol.v1.3.0.yaml` | 1.3.0 | `docs/core/agent-protocol.yaml` | `656c2c9` (К4.1 платформы, РП31); `main@99a557d` | `46e1c7e6fdab61e5b7e5708326da5e8ae7b8dc7acc952e1c2ad177663bfc07c7` |
| `AGENT-PROTOCOL.v1.3.md` | 1.3.0, ред. 4 · 16.10.2026 (заголовок в файле — «v1.2») | `docs/core/AGENT-PROTOCOL.md` | `656c2c9` (К4.1 платформы, РП31); `main@99a557d` | `405a37bde2fbe155b5284f3809d320f6e7f6b2b795b5d6039acc0fa1822c3ab4` |

Переход 1.2.0 → 1.3.0 — Р31 (agentic-core v0.6.0). Отличия yaml: коды `REQUEST_INVALID` (400) и `KEY_INVALID` (422) с `retry` `after_fix`, ответы 400, 409, 422, 503 у `POST /pao/v1/agent/keys`; схемы не менялись.

Предыдущие копии (удалены из рабочего дерева, есть в истории git):

| Файл | Версия | sha-256 |
|---|---|---|
| `agent-protocol.v1.2.0.yaml` | 1.2.0 | `4f42e8b62599c88a8291ef3dd797c92e00a4932067eef23271c76943e4407940` |
| `AGENT-PROTOCOL.v1.2.md` | 1.2, ред. 11.10.2026 | `e8ffdd3be8a1b3062b88154a54e08fc06364b6abb205bdd39a2757216798c8bd` |
| `agent-protocol.v1.0.0.yaml` | 1.0.0 | `3e67ff763b8952006ca3cb83142408d2e58c840af71b85a36aaaaca19cddb262` |
| `AGENT-PROTOCOL.v1.0.0.md` | 1.0 | `bd4424a3f9fc7dd8ba37a72b5532d25226136bcf6ceda9d47e82fd90b2f0d437` |

## Порядок перехода (Р20)

1. Платформа выпускает новую версию ПАО; agentic-core выпускает версию с ней (`PAO_VERSION`, `PAO_SPEC_SHA256`).
2. Агент переходит на эту версию agentic-core через `/decision`, копирует yaml и md из `main` платформы, обновляет эту таблицу.
3. Тест `tests/contract/pao-copy.test.ts` сверяет sha-256 копии yaml с `PAO_SPEC_SHA256` подключённого agentic-core; адаптер `pao` при старте сверяет `PAO_VERSION` с версией копии и отказывает при расхождении.
