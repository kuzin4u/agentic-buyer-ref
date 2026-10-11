# Источник копии ПАО

Владелец протокола — репозиторий Платформы (`agentic-ps-platform`, РП7). Здесь — копия фиксированной версии; вручную не правится.

| Файл | Версия | Источник | Коммит | sha-256 |
|---|---|---|---|---|
| `agent-protocol.v1.2.0.yaml` | 1.2.0 | `docs/core/agent-protocol.yaml` | `04b7841` (РП16); `main@4877f54` | `4f42e8b62599c88a8291ef3dd797c92e00a4932067eef23271c76943e4407940` |
| `AGENT-PROTOCOL.v1.2.md` | 1.2, ред. 11.10.2026 | `docs/core/AGENT-PROTOCOL.md` | `3d419d0` (PS-04 `/finish`, РП23, аудит №14); `main@4877f54` | `e8ffdd3be8a1b3062b88154a54e08fc06364b6abb205bdd39a2757216798c8bd` |

Предыдущие копии (удалены из рабочего дерева, есть в истории git):

| Файл | Версия | sha-256 |
|---|---|---|
| `agent-protocol.v1.0.0.yaml` | 1.0.0 | `3e67ff763b8952006ca3cb83142408d2e58c840af71b85a36aaaaca19cddb262` |
| `AGENT-PROTOCOL.v1.0.0.md` | 1.0 | `bd4424a3f9fc7dd8ba37a72b5532d25226136bcf6ceda9d47e82fd90b2f0d437` |

## Порядок перехода (Р20)

1. Платформа выпускает новую версию ПАО; agentic-core выпускает версию с ней (`PAO_VERSION`, `PAO_SPEC_SHA256`).
2. Агент переходит на эту версию agentic-core через `/decision`, копирует yaml и md из `main` платформы, обновляет эту таблицу.
3. Тест `tests/contract/pao-copy.test.ts` сверяет sha-256 копии yaml с `PAO_SPEC_SHA256` подключённого agentic-core; адаптер `pao` при старте сверяет `PAO_VERSION` с версией копии и отказывает при расхождении.
