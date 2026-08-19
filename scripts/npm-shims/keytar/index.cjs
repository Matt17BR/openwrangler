"use strict";

/* global module */

function unavailable() {
  throw new Error(
    "Native VSCE credential storage is disabled. Use an explicit noninteractive token or VSCE_STORE=file."
  );
}

module.exports = Object.freeze({
  deletePassword: unavailable,
  findCredentials: unavailable,
  findPassword: unavailable,
  getPassword: unavailable,
  setPassword: unavailable
});
