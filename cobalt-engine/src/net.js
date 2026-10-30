// Global fetch is all the engine needs. A thin module keeps ported service code
// unchanged (they import { fetch } from "undici") and gives one place to add
// retries or a shared dispatcher later.

export const fetch = globalThis.fetch.bind(globalThis);

export default fetch;
