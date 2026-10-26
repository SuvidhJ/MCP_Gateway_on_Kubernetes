// Upstream credentials at rest: AES-256-GCM with a key from the `gateway-app` Secret (CREDENTIAL_KEY), so a database
// dump or backup alone doesn't reveal them (the provisioner seals the credentials it registers the same way).
import { makeSealer } from '@urumi/shared';
import { config } from './config.js';

export const { seal, unseal } = makeSealer(config.credentialKey);
