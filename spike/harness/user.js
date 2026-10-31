// Throwaway spike profile prefs. NEVER use in a real profile.
user_pref("remote.prefs.recommended", false);
user_pref("zen.welcome-screen.seen", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("app.update.disabledForTesting", true);
user_pref("app.update.auto", false);
user_pref("app.update.checkInstallTime", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.aboutwelcome.enabled", false);
// Resume the previous session so restart checks see the same tabs and groups.
user_pref("browser.startup.page", 3);
user_pref("browser.startup.homepage", "about:blank");
user_pref("browser.newtabpage.enabled", false);
user_pref("browser.safebrowsing.malware.enabled", false);
user_pref("browser.safebrowsing.phishing.enabled", false);
user_pref("browser.safebrowsing.downloads.enabled", false);
user_pref("browser.safebrowsing.update.enabled", false);
user_pref("extensions.update.enabled", false);
user_pref("extensions.getAddons.cache.enabled", false);
user_pref("network.captive-portal-service.enabled", false);
user_pref("network.connectivity-service.enabled", false);
user_pref("network.prefetch-next", false);
user_pref("network.dns.disablePrefetch", true);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("services.settings.server", "data:,#remote-settings-disabled");
user_pref("browser.region.update.enabled", false);
user_pref("browser.search.update", false);
user_pref("geo.provider.network.url", "");
// Never fall back to DIRECT when the PAC's dead proxy refuses. Firefox's own "conservative"
// service requests (remote settings, updates, GMP) otherwise bypass the block.
user_pref("network.proxy.failover_direct", false);
user_pref("dom.push.connection.enabled", false);
user_pref("media.gmp-manager.url", "data:text/plain,");
user_pref("app.update.url", "");
// Throwaway profile only: allow the unsigned spike extension to install permanently.
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
