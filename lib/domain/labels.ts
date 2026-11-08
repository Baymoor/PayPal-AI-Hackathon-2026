/**
 * Payment-mode labels, the one spelling used by server views and UI badges alike. Pure constants (no
 * imports) so client components can share them with the server. The fixture label must always say
 * plainly that it is not real PayPal (hackathon honesty rule; see CLAUDE.md).
 */
export const FIXTURE_PAYMENT_LABEL = "Fixture · not real PayPal";
export const PAYPAL_SANDBOX_LABEL = "PayPal sandbox";
