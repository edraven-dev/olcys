# @olcys/llm

Klient modelu zgodny z API OpenAI, wersjonowany rejestr promptów, odpowiedzi zgodne ze schematem JSON i dziennik wywołań. Wyłącznie sugestie — nigdy część Wskaźnika Pewności.

- **Zależności:** kontrakty `@olcys/core` i `zod` (schematy promptów). Brak SDK OpenAI, LiteLLM i klientów HTTP:
  cały ruch sieciowy przechodzi przez port `EgressClient` łączony w `apps/worker` (test pilnuje listy zależności).
- **Testy:** `test/*.test.ts`, uruchamiane poleceniem `pnpm vitest run --project @olcys/llm`.

## Publiczne API

- `createLlmClient({ http, blobs, log, clock, config })` → `LlmClient`. Jedno `POST {baseUrl}/chat/completions` z
  ciałem `model, messages (system + user), temperature, seed, max_tokens, stream: false, response_format`
  (`json_schema`, `strict: true`); nigdy `tools`, `tool_choice`, `functions` ani `logprobs`. Bez automatycznych
  ponowień. `complete()` zwraca `LlmResult`: `{ ok: true, output, callId, model }` albo
  `{ ok: false, code, message, callId }` z kodem `disabled`, `input_rejected`, `egress_denied`, `timeout`,
  `http_error`, `invalid_json` lub `schema_violation`. Znane błędy (odmowa wyjścia, brak nagrania, przekroczenie czasu, błąd transportu) są wynikami typowanymi; każdy inny
  błąd (zapis blobu, dziennik wywołań, błąd w kodzie) jest rzucany dalej. Każda próba (także odrzucona przed siecią) trafia do
  `LlmCallLog` (`llm_call`).
- Zabezpieczenia przed wywołaniem sieci: `LLM_ENABLED=false` → `disabled`; wejście ze źródła z `llmAllowed: false` albo
  dłuższe niż `maxInputChars` → `input_rejected`.
- `wrapUntrusted(tekst, promptSha256)` — normalizacja NFC, usunięcie znaków sterujących i niewidocznych, zamiana
  `<<<` i `>>>` na `‹‹‹` i `›››`, opakowanie w `<<<UNTRUSTED_DATA id={nonce}>>>` … `<<<END_UNTRUSTED_DATA id={nonce}>>>`.
  Znacznik `nonce` (16 znaków szesnastkowych skrótu promptu i tekstu) jest deterministyczny, więc żądania można
  odtworzyć, a dane nie mogą go podrobić. Każdy prompt systemowy mówi (po polsku), że oznaczony tekst to dane, nie polecenia.
- `definePrompt`, `getPrompt(zadanie, wersja?)`, `buildLlmRequest` — rejestr promptów (`src/prompts/<zadanie>/v<N>.ts`).
  Skrót promptu obejmuje zadanie, wersję, język, prompt systemowy, schemat JSON i parametry. Wydane wersje są
  niezmienne: `prompts.lock.json` wiąże `<zadanie>@<wersja>` ze skrótem, a `pnpm --filter @olcys/llm prompts:lock`
  tylko dopisuje wpisy (zmiana wydanego promptu wymaga nowej wersji; test blokady zgłasza
  „prompt changed without version bump: zadanie@wersja”). Konkretne prompty dodają zadania, które z nich korzystają.
- `llmConfigFromEnv(env)` — `LLM_ENABLED`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_MODEL_DIGEST`,
  `LLM_SOURCE_ID` (domyślnie `local_llm`), `LLM_TIMEOUT_MS` (60000), `LLM_CHAT_TEMPLATE_KWARGS` (obiekt JSON dołączany
  jako `chat_template_kwargs`, np. `{"enable_thinking":false}` dla Qwen na OVMS; domyślnie pusty, więc ciało zawiera
  tylko pola z listy wyżej). `LLM_MODEL_DIGEST` zostaje pusty dla OVMS, bo serwer nie zgłasza skrótu modelu; wpis w
  dzienniku pomija wtedy skrót.
- `z` — ponowny eksport `zod`, żeby prompty w innych pakietach nie potrzebowały własnej zależności.

## Konfiguracja i zgodność

Tekst sprawy może trafić tylko do źródła GREEN rodzaju `ai_model` z `sendsIdentifiersExternally: false`. Przy
`LLM_ENABLED=true` inny wpis (np. AMBER) kończy start błędem `llm_source_not_allowed` (`LlmConfigError`), a klient
sprawdza to samo przy każdym wywołaniu (`egress_denied`). Zdalne (AMBER) punkty końcowe modelu wymagają zatwierdzenia
w zakresie sprawy z uzasadnieniem — poza zakresem MVP. Wyłączony model (`LLM_ENABLED=false`) nie wymaga magazynu wywołań.

Punkt końcowy modelu to źródło `local_llm` w `config/sources.yaml` (rodzaj `ai_model`, GREEN, tylko hosty lokalne,
`sendsIdentifiersExternally: false`). `apps/worker/src/llm.ts` buduje dla niego osobnego klienta wyjścia (lista
dozwolonych hostów, limit zapytań, dziennik wyjścia, koperta pochodzenia) i zapisuje wywołania w `llm_call`. Domyślnie
działa lokalny OpenVINO Model Server (`http://localhost:2140/v3`, model `qwen3.6-35b-ov`). Zdalny punkt końcowy
wymaga osobnego wpisu AMBER w rejestrze.

Test dymny z działającym modelem jest wyłączony domyślnie: `OLCYS_LLM_LIVE=1 pnpm vitest run --project @olcys/worker llm-live`
(tylko pętla zwrotna, krótki syntetyczny prompt).

Sugestie (`LlmSuggestion`) mają zerową wagę w ocenie; decyzję analityka zapisuje `POST /api/suggestions/:id/decision`.
