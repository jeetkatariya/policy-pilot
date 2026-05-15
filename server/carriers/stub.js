import { setStatus } from '../sessions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(session) {
  try {
    await sleep(1000);
    setStatus(session, 'awaiting_mfa', { mfaRequired: true });

    const code = await session._mfaPromise;
    if (!code) throw new Error('no mfa code received');

    setStatus(session, 'fetching_docs', { mfaRequired: false });
    await sleep(500);

    const documents = [
      { id: 'doc1', name: 'Declarations Page.pdf', url: `/api/sessions/${session.id}/documents/doc1` },
      { id: 'doc2', name: 'Auto Policy.pdf',       url: `/api/sessions/${session.id}/documents/doc2` },
      { id: 'doc3', name: 'ID Cards.pdf',          url: `/api/sessions/${session.id}/documents/doc3` },
    ];

    setStatus(session, 'done', { documents });
  } catch (err) {
    setStatus(session, 'failed', { error: String(err.message || err) });
  }
}
