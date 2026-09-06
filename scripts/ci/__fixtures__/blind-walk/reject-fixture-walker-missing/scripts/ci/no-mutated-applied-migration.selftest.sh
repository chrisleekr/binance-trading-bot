#!/usr/bin/env bash
# Fixture stub that walks only to build a reviewed self-test fixture.
bun -e 'require("node:fs").readdirSync(".")'
