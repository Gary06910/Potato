'use strict';

// Model a long-running collector so IPC loss cannot end the fixture by itself.
setInterval(() => {}, 60_000);
