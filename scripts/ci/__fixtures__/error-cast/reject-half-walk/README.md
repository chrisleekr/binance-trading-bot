Half a walk: `packages/` is populated and carries its anchor, `apps/` does not
exist at all. A union walk with one shared file floor and one shared anchor
reports a confident count here while never examining apps/api, apps/worker or
apps/web.
