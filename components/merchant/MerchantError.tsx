import { MERCHANT_ERROR_COPY } from "@/components/errors/errorCopy";
import {
  asSentence,
  describeError,
  describeErrorFacts,
  type CopyOverrides,
  type FriendlyError,
} from "@/components/errors/friendlyError";

const merchantCopy = (extra?: CopyOverrides): CopyOverrides => (extra ? { ...MERCHANT_ERROR_COPY, ...extra } : MERCHANT_ERROR_COPY);

/** Merchant wording for any failure: merchant-specific copy first (and any screen extras), then the shared copy. */
export function describeMerchantError(error: unknown, extra?: CopyOverrides): FriendlyError {
  return describeError(error, "dashboard", merchantCopy(extra));
}

/** For failures the client detects itself (no thrown API error), e.g. UNSAFE_FILTER. */
export function describeMerchantCode(code: string): FriendlyError {
  return describeErrorFacts({ code }, "dashboard", merchantCopy());
}

/** Inline form that fits the merchant banners (`m-banner`, `m-error`): bold title, then plain sentences. */
export function MerchantErrorText({ error }: { error: FriendlyError }) {
  return (
    <>
      <strong>{error.title}.</strong> {asSentence(error.explanation)}
      {error.nextStep && <> {error.nextStep}</>}
    </>
  );
}
