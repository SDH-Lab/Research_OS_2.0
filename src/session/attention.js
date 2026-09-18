// Derived advice, never a second task store or a scientific acceptance decision.
export function actionAttention(records, asOf) {
  const byId = new Map([...records.values()].map(record => [record.id, record]));
  const items = [];
  for (const record of records.values()) {
    const action = record.attributes;
    if (action.type !== 'action' || ['closed', 'cancelled', 'superseded', 'deferred'].includes(action.status)) continue;
    for (const blocker of action.blockers ?? []) {
      if (blocker.status !== 'active') continue;
      items.push({ code: 'ACTION_BLOCKED', actionId: record.id, path: record.path,
        message: blocker.description, since: blocker.since, category: blocker.category ?? null,
        nextAction: blocker.next_unblock_action });
    }
    if (['review', 'verified'].includes(action.status)) {
      items.push({ code: 'ACTION_AWAITING_ACCEPTANCE', actionId: record.id, path: record.path,
        message: 'Evaluate the result, then explicitly accept and close or record remaining work.' });
    } else if (action.outputs?.length && action.outputs.every(id => byId.get(id)?.attributes.status === 'closed')) {
      items.push({ code: 'OUTPUTS_COMPLETE_ACTION_OPEN', actionId: record.id, path: record.path,
        message: 'All declared output records are closed; reconcile the Action acceptance and next step.' });
    }
    const latest = action.status_history?.at(-1)?.at ?? action.created;
    if (action.review_at && action.review_at.slice(0, 10) <= asOf) {
      items.push({ code: 'ACTION_REVIEW_DUE', actionId: record.id, path: record.path,
        message: `Review the scope and priority agreed for ${action.review_at}.`, unchangedSince: latest });
    }
  }
  return items;
}
