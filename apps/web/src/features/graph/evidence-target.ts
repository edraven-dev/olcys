import type { AddressRef } from '@olcys/core';
import { isRejectingDecision, keyOf, type ExclusionView } from '../../lib/domain.ts';
import { routePath } from '../../lib/router.tsx';

/**
 * Where "show evidence" for a link leads. Main-table links open their card in „Powiązane adresy”; rejected ones
 * (the links table does not list them) open the exclusion card of the address, or its card among the relations
 * without an ownership claim, in „Odrzucone adresy”.
 */
export function evidencePath(
  run: { caseId: string; id: string },
  target: { linkId: string; address: AddressRef | undefined; rejected: boolean },
  exclusions: readonly ExclusionView[],
): string {
  const path = (tab: 'links' | 'rejected') => routePath({ name: 'run', caseId: run.caseId, runId: run.id, tab });
  if (!target.rejected) return `${path('links')}#link-${target.linkId}`;
  const decisions = target.address ? exclusions.filter((d) => keyOf(d.address) === keyOf(target.address!)) : [];
  const decision = decisions.find(isRejectingDecision) ?? decisions[0];
  return decision ? `${path('rejected')}#exclusion-${decision.id}` : `${path('rejected')}#link-${target.linkId}`;
}
