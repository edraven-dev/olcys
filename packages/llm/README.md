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

## Zamiana modelu

Model jest wskazywany wyłącznie przez środowisko; kod się nie zmienia. Wystarczy `LLM_BASE_URL` i `LLM_MODEL` (oraz,
jeśli serwer tego wymaga, `LLM_CHAT_TEMPLATE_KWARGS`, np. `{"enable_thinking":false}` dla Qwen):

| Serwer                                    | `LLM_BASE_URL`              | `LLM_MODEL`                  |
| ----------------------------------------- | --------------------------- | ---------------------------- |
| OpenVINO Model Server (domyślnie)         | `http://localhost:2140/v3`  | `qwen3.6-35b-ov`             |
| Ollama (profil compose `llm`)             | `http://127.0.0.1:11434/v1` | nazwa z `ollama list`        |
| llama.cpp (profil compose `llm-llamacpp`) | `http://127.0.0.1:8081/v1`  | `LLAMACPP_ALIAS`             |
| vLLM (host z GPU, poza compose)           | `http://127.0.0.1:8000/v1`  | identyfikator z `vllm serve` |

Po zmianie `.env` uruchom `pnpm llm:check`: polecenie czyta te same zmienne co worker, wypisuje host punktu
końcowego, model, listę modeli serwera (`GET {base}/models`), skrót modelu (`LLM_MODEL_DIGEST` albo „brak skrótu
modelu”), wynik jednej próby ze ścisłym schematem JSON na syntetycznym wejściu oraz opóźnienie. Próba przechodzi przez
ten sam klient i ten sam klient wyjścia co analizy (źródło `local_llm`, lista dozwolonych hostów, dziennik wyjścia).
Przy błędzie (serwer niedostępny, modelu nie ma na liście, odpowiedź niezgodna ze schematem) kod wyjścia jest różny od
zera. Test `apps/worker/test/llm-swap.test.ts` dowodzi zamiany na dwóch atrapach serwerów na `127.0.0.1`.

Każdy uruchomiony przebieg zapisuje tożsamość modelu w migawce konfiguracji (`config.llm`): adres bazowy bez danych
logowania i zapytania, identyfikator modelu, `LLM_MODEL_DIGEST` albo `none` i znacznik włączenia. Każdy dozwolony punkt
końcowy to źródło GREEN z pętli zwrotnej; inny host wymaga osobnego wpisu w `config/sources.yaml`.

Model o dobrej znajomości polskiego na licencji Apache-2.0 (np. Bielik 11B v3 Instruct, SpeakLeash) pobiera się
ręcznie, jednorazowo i poza analizą (pobranie nie niesie danych sprawy; OŁCyŚ niczego nie pobiera sam): w Ollamie
`ollama pull` z biblioteki modeli, w llama.cpp przez plik GGUF umieszczony w `data/models/` (`LLAMACPP_MODEL_FILE`,
`LLAMACPP_ALIAS`) i `LLM_MODEL_DIGEST=sha256:<suma kontrolna pliku>`. Profile compose `llm` i `llm-llamacpp` mają wyłączone
funkcje chmurowe i telemetrię, porty wiązane do `127.0.0.1` oraz testy zdrowia.

Test dymny z działającym modelem jest wyłączony domyślnie: `OLCYS_LLM_LIVE=1 pnpm vitest run --project @olcys/worker llm-live`
(tylko pętla zwrotna, krótki syntetyczny prompt).

Sugestie (`LlmSuggestion`) mają zerową wagę w ocenie; decyzję analityka zapisuje `POST /api/suggestions/:id/decision`.

## Zadanie `address-role-classification` (v1): rola wzmianki o adresie

`classifyAddressMention` prosi model o zasugerowanie roli wzmianki o adresie: `first_person_owner`, `payment_request`,
`donation`, `scam_report`, `warning`, `quote`, `exchange_deposit`, `listing` albo `unclear` (to samo co `ROLE_CUES` w
`@olcys/core`). Odpowiedź ma ścisły schemat JSON (`role`, `evidenceSpan` do 200 znaków, `rationale` do 300 znaków,
`confidence`; `additionalProperties: false`). Dane z strony (adres, sieć, platforma, nagłówek, etykieta, fragment)
trafiają do modelu wyłącznie jako dane w znaczniku `UNTRUSTED_DATA` (`wrapUntrusted`); długi fragment jest okienkowany
wokół adresu, a nie obcinany od końca.

Bramki przed wywołaniem (wynik `skipped`, brak żądania): model włączony; źródło może być pokazane modelowi
(`isLlmAllowed`: nieznane źródło, `llmAllowed: false`, `telegram_preview`, host Telegrama w `url`/`finalUrl` albo w
adresie oryginału kopii z archiwum — nigdy); fragment ma co najmniej 20 znaków. Po wywołaniu `evidenceSpan` musi być
dosłownym cytatem z linii `nagłówek:`, `etykieta:` lub `fragment:` (po zwinięciu białych znaków) — inaczej wynik to
`failed: span_not_in_input` i sugestia nie powstaje. `lexiconAgreement` porównuje rolę z sygnałami leksykalnymi
ekstraktora (`agrees` / `differs` / `lexicon_silent`); wynik trafia do `output.agreement`.

Wynik to sugestia o zerowej wadze: nie zapisuje żadnej przesłanki ani oceny. Krok potoku (`llm.suggest`) opisuje
`apps/worker/README.md`. Test dymny z żywym modelem: `OLCYS_LLM_LIVE=1 pnpm vitest run --project @olcys/worker suggest-roles-live`.

## Zadanie `report-inference-draft` (v1): szkice wniosków do sekcji C raportu

Na prośbę analityka (`POST /api/runs/:runId/report/drafts`, przycisk „Zaproponuj wnioski (AI)” w zakładce raportu;
tylko gdy model jest włączony) `draftInferences` prosi model o szkice wniosków „wymagających weryfikacji” na podstawie
**wyłącznie** faktów (A) i wyników obliczeń (B) zapisanego raportu — nigdy stron źródłowych. `buildDraftContext` buduje
wejście: jedna linia na pozycję, `[W:<id>] …` (wynik obliczeń; najpierw wyniki, od najwyższego Wskaźnika Pewności, potem
identyfikatory) i `[F:<id>] …` (fakt, po identyfikatorze), z pominięciem wszystkiego, co opiera się na zabezpieczeniu,
którego model nie może zobaczyć (`captureSource`, czyli `isLlmAllowed`: Telegram, źródło z `llmAllowed: false`,
nieznane źródło — bezpośrednio albo przez `basedOn`; licznik `excluded`). Cała lista jest daną w znaczniku
`UNTRUSTED_DATA`; limit 12000 znaków obcina całe linie (`truncated`), wynik jest deterministyczny.

Odpowiedź ma ścisły schemat: do 6 szkiców, każdy z `statement` (do 600 znaków), `basedOn` (1–10 identyfikatorów w
postaci `F:<id>`/`W:<id>`), `alternatives` (1–4, do 300 znaków) i `verificationSteps` (0–4, do 300 znaków); prompt
mówi po polsku, że to hipotezy, a nie ustalenia, zakazuje powtarzania wyników punktowych i ocen osoby. Po wywołaniu
szkic jest odrzucany, gdy cytuje identyfikator spoza wejścia (`dropped.unknownBasis`) albo powtarza wynik punktowy
(`%`, `/100`, „Wskaźnik Pewności”; `dropped.restatesScore`). Wynik to sugestie (`LlmSuggestion`, zadanie
`report-inference-draft`, `target.reportId`, `label: 'draft'`, `output` = `InferenceDraft`) o zerowej wadze: nie
zmieniają ocen ani podsumowania. Decyzja (potwierdź lub odrzuć, uzasadnienie co najmniej 10 znaków, opcjonalnie
poprawiony tekst `editedText`) zapada przez `POST /api/suggestions/:id/decision`; w raporcie pojawiają się tylko
potwierdzone szkice (opis w `packages/reporting/README.md`). Test dymny z żywym modelem (dane syntetyczne):
`OLCYS_LLM_LIVE=1 pnpm vitest run --project @olcys/worker draft-inferences-live`.
