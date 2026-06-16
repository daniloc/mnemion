// Shared test helpers. The DO-keying and create-pattern flows were copy-pasted
// into every test file; new tests import from here instead so a change to the
// keying scheme or the create_pattern payload is made in one place. (Existing
// suites still carry their own copies — migrating them is a separate cleanup.)
import { env } from "cloudflare:test";
import type { HiveDO } from "../hive";

/** A fresh, isolated HiveDO stub keyed by a random id. */
export function getStore(): DurableObjectStub<HiveDO> {
  const id = env.MNEMION_HIVE.idFromName(`user:test:${crypto.randomUUID()}`);
  return env.MNEMION_HIVE.get(id);
}

/** Create a user pattern via propose + apply. Defaults to a single text facet. */
export async function createPattern(
  store: DurableObjectStub<HiveDO>,
  name: string,
  facets: { name: string; type: string; required?: boolean; links?: { pattern: string; facet?: string } }[] = [{ name: "body", type: "text" }],
  description?: string,
): Promise<any> {
  const proposed = JSON.parse(await store.proposeChange(
    `Create ${name}`,
    JSON.stringify({
      type: "create_pattern",
      pattern_name: name,
      pattern_description: description || `Test pattern: ${name}`,
      doctrine: `Test doctrine for ${name}`,
      facets,
    }),
  ));
  if (proposed.error) throw new Error(proposed.message);
  return JSON.parse(await store.applyChange(proposed.change_id));
}
