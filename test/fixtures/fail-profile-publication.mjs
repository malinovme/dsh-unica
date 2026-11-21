// The wrapper's publisher receives the draft, live profile and baseline. Inject
// a filesystem failure only there, independent of the runner's privileges.
import fs from 'node:fs'

if (process.argv[2] === process.env.FIXTURE_PROFILE) {
  const deny = () => { throw Object.assign(new Error('fixture: profile directory denied access'), { code: 'EACCES' }) }
  if (process.env.FIXTURE_PUBLICATION_FAILURE === 'copy') fs.copyFileSync = deny
  if (process.env.FIXTURE_PUBLICATION_FAILURE === 'cleanup') fs.rmSync = deny
}
