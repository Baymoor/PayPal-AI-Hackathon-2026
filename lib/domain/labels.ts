/**
 * Honesty labels, the one spelling used by server views and UI badges alike. Pure constants (no imports)
 * so client components can share them with the server.
 *
 * Visitors read "Simulated" and "Sample"; the code keeps calling the same thing FIXTURE (enums, provider
 * names, env vars). The payment label must always say plainly that it is not real PayPal, and the AI label
 * that no model was called (hackathon honesty rule; see CLAUDE.md).
 */
export const FIXTURE_PAYMENT_LABEL = "Simulated · not real PayPal";
export const FIXTURE_AI_LABEL = "Sample AI text (no model call)";
/** What a simulated booking is called wherever bookings are listed (dashboard source, row type, widgets). */
export const FIXTURE_ROW_LABEL = "Simulated";
export const PAYPAL_SANDBOX_LABEL = "PayPal sandbox";
