# @olcys/core

Model domeny i kontrakty współdzielone przez wszystkie pakiety OŁCyŚ: typy, porty, schematy zod, generator
identyfikatorów UUIDv7, arytmetyka dziesiętna i kanoniczny JSON (RFC 8785). Minimalne zależności (zod, big.js); działa
zarówno w Node.js, jak i w przeglądarce.

| Plik                | Zawartość                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/common.ts`     | `Id`, `IsoDateTime`, `Sha256Hex`, `DecimalString`                                                                                                                   |
| `src/chains.ts`     | `ChainId` (`bitcoin`, `evm:<id>`, `tron`, …), `AddressRef`, `KNOWN_CHAINS`, `addressKey()`                                                                          |
| `src/sources.ts`    | `SourceDescriptor`, status zgodności GREEN/AMBER/RED, ocena wiarygodności w skali Admiralicji                                                                       |
| `src/case.ts`       | `Case`, `Identifier`, `AnalysisRun`, `RunConfigSnapshot`                                                                                                            |
| `src/provenance.ts` | `ProvenanceEnvelope`, `EgressLogEntry`, `BlobRef`, `FetchMode`                                                                                                      |
| `src/evidence.ts`   | `Capture` (pola Protokołu Berkeley), `CaptureManifest`/`CaptureDraft` (manifest przechwycenia), `ClockSyncStatus`, `CustodyEvent`, `OnlineAccount`, `Observation`   |
| `src/extraction.ts` | `AddressCandidate`, `SecretFinding`, `ExtractionResult`                                                                                                             |
| `src/chain-data.ts` | `NormalizedTransfer`, `UtxoTransaction`, `AddressSummary`                                                                                                           |
| `src/labels.ts`     | `AddressLabel`, `AddressTypeClassification` (typ adresu z sondami), `ExclusionDecision` (reguły A1–A8)                                                              |
| `src/analytics.ts`  | `Valuation` (NBP), `CashOutEvent` (reguły B1–B7), `ActivityIndicators`, `FlowEdge`                                                                                  |
| `src/scoring.ts`    | poziomy dowodów E1–E4/AUTH, `Relation`, `LinkAssessment`, `HopResult`, `AnalystJudgement`, `AnalystOverride`, `ADD_EVIDENCE_FEATURES`                               |
| `src/changes.ts`    | `ChangeEvent` (ADDED / REMOVED / VALUE_CHANGED / SCORE_CHANGED)                                                                                                     |
| `src/schedule.ts`   | harmonogram analiz okresowych: `ScheduleTick`, `CaseScheduleChange`, `CaseScheduleState`, `UpdateScheduleSchema`; port `ScheduleRepository`                         |
| `src/llm.ts`        | model AI: `LlmClient`, `LlmRequest`, `LlmResult` (kody błędów `LLM_FAILURE_CODES`), `LlmCallRecord`, `LlmSuggestion`, `LlmSuggestionDecision`; port `LlmRepository` |
| `src/report.ts`     | `ReportModel` z rozdzieleniem faktów, wyników obliczeń i wniosków                                                                                                   |
| `src/ports.ts`      | `EgressClient`, `BlobStore`, `SourceCollector`, `ChainProvider`, `LabelLookup`, `FxRateSource`, `PriceSource`, `SearchProvider`, `RunContext`, `CaptureRecorder`    |

Port `ChainProvider` ma opcjonalne odczyty stanu dla klasyfikacji typu adresu: `getStorageAt(address, slot)` i
`call(address, data)` (`ChainCallResult`: odpowiedź albo wycofanie wywołania — negatywny wynik, nie błąd); dostawca
bez nich pomija te sondy. Typy adresów przebiegu zapisuje opcjonalny port `AddressTypeRepository`
(`Repositories.addressTypes`).

**Zmiana niekompatybilna** elementów eksportowanych z tego pakietu wymaga podniesienia `CORE_CONTRACTS_VERSION`
i aktualizacji wszystkich użytkowników w tej samej zmianie; zmiany addytywne (nowe typy, nowe pola opcjonalne) nie
wymagają podniesienia wersji (zob. AGENTS.md).
