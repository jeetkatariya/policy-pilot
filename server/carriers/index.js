import * as stub from './stub.js';
import * as stubPw from './stub-pw.js';
import * as progressive from './progressive.js';
import * as lemonade from './lemonade.js';
import * as petsbest from './petsbest.js';
import * as erenterplan from './erenterplan.js';

const REGISTRY = {
  stub,
  'stub-pw': stubPw,
  progressive,
  lemonade,
  petsbest,
  erenterplan,
};

export function getCarrier(name) {
  return REGISTRY[name] || null;
}

// Carriers shown in the UI dropdown. Internal-only entries (stub / stub-pw used
// by the smoke test, plus carriers we haven't shipped to production) live in
// REGISTRY but are not surfaced to end users.
export function listCarriers() {
  return [
    { id: 'lemonade',    name: 'Lemonade',    requiresPassword: false },
    { id: 'petsbest',    name: 'Pets Best',   requiresPassword: true },
    { id: 'erenterplan', name: 'eRenterPlan', requiresPassword: true },
  ];
}
