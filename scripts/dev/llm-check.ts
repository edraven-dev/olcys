/**
 * `pnpm llm:check`: checks the configured model server (LLM_BASE_URL, LLM_MODEL) the way the worker uses it: lists the
 * served models and runs one strict-JSON-schema probe on a synthetic input. Exits non-zero on any failure.
 */
import { runLlmCheck } from '../../apps/worker/src/llm-check.ts';

const mode =
  process.env['OLCYS_MODE'] === 'live' || process.env['OLCYS_MODE'] === 'replay'
    ? process.env['OLCYS_MODE']
    : 'offline';

let result;
try {
  result = await runLlmCheck(process.env, mode);
} catch (error) {
  console.error(`llm:check: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

console.log(`Punkt końcowy:  ${result.endpoint}`);
console.log(`Model:          ${result.model}${result.modelListed ? '' : ' (niewidoczny na liście serwera)'}`);
console.log(`Modele serwera: ${result.served.length ? result.served.join(', ') : '(brak)'}`);
console.log(`Skrót modelu:   ${result.modelDigest ?? 'brak skrótu modelu'}`);
console.log(
  `Próba JSON:     ${result.probe.ok ? `OK ${JSON.stringify(result.probe.output)}` : `BŁĄD ${result.probe.code}: ${result.probe.message}`}`,
);
console.log(`Opóźnienie:     ${result.latencyMs} ms`);
for (const problem of result.problems) console.error(`Problem: ${problem}`);
console.log(result.ok ? 'WYNIK: OK' : 'WYNIK: BŁĄD');
process.exit(result.ok ? 0 : 1);
