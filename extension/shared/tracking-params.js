// Tracking query parameters that extras.js removes before it compares URLs for duplicates
// (notes/m4-contracts.md, "Duplicates"). Names compare after percent-decoding and ASCII lower-casing, as Firefox's
// own stripper does, so "FBCLID" and "fb%63lid" are fbclid too. Everything else in a URL is kept exactly.
//
// Source: the installed Zen 1.23.4b (Firefox 158.0.1, build 20261020090730), read from copies of its files.
// - Firefox strips the parameters of the "query-stripping" Remote Settings collection plus those in the pref
//   privacy.query_stripping.strip_list (modules/URLQueryStrippingListService.sys.mjs in omni.ja).
// - This build bundles no dump of that collection: omni.ja and browser/omni.ja hold no query-stripping file under
//   defaults/settings, so the list only exists once Remote Settings has synced. The pref has no default either:
//   greprefs.js and defaults/preferences/firefox.js don't set it, and xul.dll holds these names only as the labels
//   below, never as a default value.
// - The one copy of the list's parameter names in the build is xul.dll's query-stripping telemetry: the labels
//   "param_<name>" of QUERY_STRIPPING_COUNT_BY_PARAM and contentblocking.query_stripping_count_by_param, which
//   count each stripped parameter. TRACKING_PARAMS holds those names, in the same order. The synced collection may
//   hold more; these are the names the build itself vouches for, and a name left out only means a duplicate that
//   isn't offered, never a different page offered as one.
// - Not used: StripOnShare.json, the "Copy Clean Link" list. It is meant for cleaning a link someone chose to share
//   and holds generic names such as "var" and "adid" that sites also use for content, so two different pages
//   could compare equal.
//
// Plus the utm_* family (utm_source, utm_medium, ...) as a prefix rule, which the contract adds.

export const TRACKING_PARAMS = Object.freeze([
  "mc_eid", "oly_anon_id", "oly_enc_id", "__s", "vero_id", "_hsenc", "mkt_tok", "fbclid", "gclid", "dclid",
  "msclkid", "_openstat", "yclid", "wickedid", "twclid", "__hssc", "__hstc", "__hsfp", "hsctatracking", "wbraid",
  "gbraid", "ysclid",
]);

// A parameter whose lower-cased name starts with one of these is a tracking parameter too.
export const TRACKING_PARAM_PREFIXES = Object.freeze(["utm_"]);
