import * as stubPw from './stub-pw.js';
import * as lemonade from './lemonade.js';
import * as petsbest from './petsbest.js';
import * as erenterplan from './erenterplan.js';

// `stub-pw` is internal-only: it backs the offline smoke test against the
// local fake-portal. It is not exposed by listCarriers() so the UI dropdown
// only shows real carriers.
const REGISTRY = {
  'stub-pw': stubPw,
  lemonade,
  petsbest,
  erenterplan,
};

export function getCarrier(name) {
  return REGISTRY[name] || null;
}

export function listCarriers() {
  return [
    { id: 'lemonade',    name: 'Lemonade',    requiresPassword: false },
    { id: 'petsbest',    name: 'Pets Best',   requiresPassword: true },
    { id: 'erenterplan', name: 'eRenterPlan', requiresPassword: true },
  ];
}
