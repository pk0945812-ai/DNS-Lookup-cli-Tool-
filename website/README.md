# DNS Lookup Studio

A browser interface for querying public DNS records and generating the corresponding `dig` command.

## Run locally

Open `index.html` in a modern browser. A static HTTP server can also serve the `website` folder. The project has no build step or dependency installation. Live lookups require internet access to the chosen DNS resolver.

Choose a resolver and record type, enter a domain, and select **Run lookup**. For PTR lookups, enter an IPv4 or IPv6 address or an existing reverse DNS name. The results include the record name, type, TTL in seconds, and value. Copy the results or the `dig` command using the buttons beside them.

Lookups go directly to Google Public DNS or Cloudflare over HTTPS. The browser saves the most recent queries locally. Use **Clear** in Recent lookups to remove them.

## Source

- `index.html` contains the page and form.
- `styles.css` defines the layout and responsive styles.
- `app.js` handles lookups, results, clipboard, and history.
