# Privacy

cellforge runs entirely in your browser tab.

- **Your files are never uploaded.** They're read and processed on your computer.
- **No account, no tracking, no analytics.**
- **The only downloads are the app itself**, and an AI model if you press a
  Download button for one. The button names the site and the size; the model
  then runs on this computer and nothing you type is sent anywhere. See
  [The local AI](46-local-ai.md).

This is a design rule, not a setting: every planned feature, including the
assistant, is built to work without a server. See the
[vision](#/dev/VISION) for why.

## Where your work is kept

Autosave writes to the browser's private storage for this site (the
Origin Private File System). It stays on this computer, other websites
can't read it, and it isn't synced anywhere. Clearing this site's data in
the browser settings deletes it, so **Save** a `.cellforge` file for
anything you want to keep long term.
