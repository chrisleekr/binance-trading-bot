#!/usr/bin/env bash
# Fixture gate that decides from its own unreviewed walk.
bun -e 'for (const entry of require("node:fs").readdirSync(".")) console.log(entry)'
