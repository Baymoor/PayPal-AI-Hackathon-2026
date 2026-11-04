/**
 * Payment provider registry.
 *
 * - `getPaymentProvider()` (no name): the provider for NEW payment attempts,
 *   from `config().paymentMode`: PAYPAL_SANDBOX -> PayPal, FIXTURE -> fixture
 *   simulator (only when DEMO_FIXTURES_ENABLED), DISABLED -> throws.
 * - `getPaymentProvider(name)`: the provider an existing attempt was created
 *   with (attempts store their provider name; the settlement engine resolves
 *   per attempt). PAYPAL requires credentials. FIXTURE is always resolvable so
 *   that fixture holds can still be voided after demo mode is switched off.
 */
import { config } from "../env";
import type { PaymentProviderName } from "../domain/types";
import { ProviderUnavailableError, type PaymentProvider } from "./provider";
import { PaypalProvider, PAYPAL_PROVIDER_LABEL } from "./paypal";
import { FixtureProvider, FIXTURE_PROVIDER_LABEL } from "./fixture";

const instances = new Map<PaymentProviderName, PaymentProvider>();
const overrides = new Map<PaymentProviderName, PaymentProvider>();

/** Which provider new attempts use right now. Throws ProviderUnavailableError when payments are disabled. */
export function defaultPaymentProviderName(): PaymentProviderName {
  const c = config();
  if (c.paymentMode === "PAYPAL_SANDBOX") return "PAYPAL";
  if (c.paymentMode === "FIXTURE" && c.demoFixturesEnabled) return "FIXTURE";
  throw new ProviderUnavailableError(
    "Payments are disabled: configure PayPal sandbox credentials, or set DEMO_FIXTURES_ENABLED=true for the labelled fixture simulator",
  );
}

export function getPaymentProvider(name?: PaymentProviderName): PaymentProvider {
  const resolved = name ?? defaultPaymentProviderName();
  const override = overrides.get(resolved);
  if (override) return override;
  const cached = instances.get(resolved);
  if (cached) return cached;
  let created: PaymentProvider;
  if (resolved === "PAYPAL") {
    created = PaypalProvider.fromConfig(); // throws without credentials
  } else if (resolved === "FIXTURE") {
    created = new FixtureProvider();
  } else {
    throw new ProviderUnavailableError(`Unknown payment provider ${String(resolved)}`);
  }
  instances.set(resolved, created);
  return created;
}

/** UI badge text. Never present FIXTURE as PayPal sandbox. */
export function providerLabel(name: PaymentProviderName): string {
  return name === "PAYPAL" ? PAYPAL_PROVIDER_LABEL : FIXTURE_PROVIDER_LABEL;
}

/**
 * TEST / TOOLING ONLY: substitute a provider (e.g. a FixtureProvider bound to
 * a test database or a fake with injected failures). Pass null to remove.
 */
export function setPaymentProviderOverride(name: PaymentProviderName, provider: PaymentProvider | null): void {
  if (provider) overrides.set(name, provider);
  else overrides.delete(name);
}

/** Drop cached instances (e.g. after config changes in tests). */
export function resetPaymentProviders(): void {
  instances.clear();
  overrides.clear();
}

export { ProviderUnavailableError } from "./provider";
export type { PaymentProvider } from "./provider";
export { FixtureProvider, FIXTURE_PROVIDER_LABEL } from "./fixture";
export { PaypalProvider, PAYPAL_PROVIDER_LABEL } from "./paypal";
