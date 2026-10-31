# Zen Tidy

Zen Tidy is a Firefox extension for [Zen Browser](https://zen-browser.app). It sorts your loose tabs into topic
groups with Claude, using your own Anthropic API key. This repository holds its releases only: the signed extension,
the update manifest Zen reads, checksums, and an optional stylesheet kit.

1. Click the Zen Tidy toolbar button.
2. It sends your loose tabs to Claude: title, site and a short path. Tabs that look sensitive send only the site.
3. You get a **preview** of the groups. Rename them, change their icons, move or untick tabs.
4. **Apply** moves the tabs into tab groups. **Undo** puts them back, even after a restart.

Nothing runs unless you click. Essentials, pinned tabs, Zen folders and split views are never moved.

Made for Zen Browser on Windows.

## Install

1. Open the [latest release](https://github.com/Soulmenls/zen-tidy/releases/latest) and download
   `zen-tidy-<version>.xpi`.
2. In Zen, open `about:addons`, click the gear button, choose **Install Add-on From File...** and pick the file.
3. Zen lists what Zen Tidy asks for: access to your tabs, tab groups and recently closed tabs, to
   `api.anthropic.com`, and the browsing activity it sends there. Add it.
4. Open Zen Tidy's settings (`about:addons` > Zen Tidy > Options), paste your Anthropic API key and click **Save**.
   **Test key** checks it without spending tokens.

The extension is signed by Mozilla (an unlisted, self-distributed add-on), so Zen installs it with its signature
checks on. Never turn signature checks off to install anything.

## Updates

Zen looks for updates on its own and installs new versions from this repository's latest release. They are signed
the same way. Your settings, your key, the undo history and your groups stay as they are, and an update never
interrupts a tidy in progress: it waits until the tidy has finished, and while a preview waits for you, until you
apply or cancel it, so the preview is never lost. To look right away: `about:addons` > gear > **Check for Updates**.

## Verify a download

Every release has a `SHA256SUMS` file, and its notes repeat the same lines. In PowerShell, in the folder you
downloaded to, paste the hash from the file's line in `SHA256SUMS`:

```powershell
(Get-FileHash .\zen-tidy-<version>.xpi -Algorithm SHA256).Hash -eq '<hash from SHA256SUMS>'
```

`True` means the download matches. PowerShell prints hashes in capitals and `SHA256SUMS` has them in lowercase; the
letter case doesn't matter, and `-eq` ignores it. Releases here are immutable: once published, a release's files
can't be changed or replaced, and its tag can't be moved or deleted.

## Folder look (optional)

Tidy groups are plain tab groups. `zen-tidy-css-<version>.zip` holds a small stylesheet that makes them look and
behave like Zen folders (each group shows its icon; collapsing a group hides its tabs except the selected one), and
the PowerShell script that installs it into one Zen profile.

1. Unzip the kit into a folder of its own.
2. In Zen, open `about:support` and copy the **Profile Folder** path, then close Zen.
3. In the unzipped folder, see what the script would change, without writing anything:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-css.ps1 -ProfilePath "<profile folder>" -WhatIf
   ```

4. Run the same command without `-WhatIf`, then start Zen.

The script backs up `userChrome.css` and `user.js` before changing them, and is safe to run again. When a release's
notes say **Re-run setup-css.ps1**, download that release's kit and run it again. The kit's `README.txt` has the
details.

## Your key and your tabs

- **Where the key lives:** in the extension's private storage (`storage.local`, never synced). Websites and ordinary
  extensions can't read it: Zen Tidy has no content scripts, no pages open to websites and no external messaging.
- **Where it goes:** only to `https://api.anthropic.com`, in the `Authorization` header, with redirects refused. A
  content security policy lets the extension fetch nothing else.
- **Where it never appears:** prompts, logs, error messages, tab or group names, or the settings page once saved.
- **What is sent per tab:** the title (at most 120 characters) and the site with a short path. Query strings,
  `#fragments` and ID-like path parts are removed. Tabs that look sensitive (banks, brokers, health portals, webmail,
  government and more) send only the site. Anthropic deletes API inputs and outputs within 30 days and doesn't train
  on them. Content flagged for policy violations can be kept for up to 2 years.
- **Your side:** use a key scoped to a workspace of its own, with a low monthly spend limit (such as $5) and an
  expiry.
- **Outside any extension's protection:** malware running as you, anyone at your keyboard, an extension with the
  `proxy` permission and access to `api.anthropic.com`, TLS-intercepting certificates, and chrome-JS loaders in the
  profile (keep them out). The key is not encrypted on disk, so copies of your profile contain it.
- **Releases:** signed on the maintainer's own computer, never in CI. Both accounts use two-factor authentication,
  the Mozilla signing key is revoked between releases, and releases here are immutable.

## Uninstall

1. Optional: in Zen Tidy's groups view, **Remove all tidy groups** (the tabs stay, loose).
2. `about:addons` > Zen Tidy > **Remove**.
3. If you installed the folder look: close Zen, then run, from the kit's folder:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-css.ps1 -ProfilePath "<profile folder>" -Uninstall
   ```

   It removes only what the install added; its backups are kept.

## License

MIT.
