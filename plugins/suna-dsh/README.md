# SUNA DSH plugin bridge

This plugin connects the desktop application to a separately installed DSH runtime. It contains the adapter and permission contracts used by the application; it does not bundle the runtime itself.

Install the plugin through the application using a compatible runtime package. Runtime state, credentials, and account data remain in their configured local data directories.

The application sends tool requests only through configured handlers and records the runtime replies. A tool response is not treated as a delivered platform message unless the connected service confirms delivery.
