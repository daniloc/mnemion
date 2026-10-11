# Routes

HTTP route handlers for authentication, serving, ingress, and owner APIs.

## entrances
- upload document: An uploader submits a document.
  handler: uploadDocument
  trust: served-untrusted
- serve document: A client requests a stored document.
  handler: serveDocument
  trust: served-untrusted
- serve page og: A client requests page Open Graph metadata.
  handler: servePageOg
  trust: served-untrusted
- serve page og png: A client requests a page Open Graph image.
  handler: servePageOgPng
  trust: served-untrusted
- serve page: A client requests a stored page.
  handler: servePage
  trust: served-untrusted
