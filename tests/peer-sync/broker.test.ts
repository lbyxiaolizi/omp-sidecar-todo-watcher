import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, onTestFinished } from 'vitest'
import { PeerSyncBroker } from '../../src/peer-sync/broker.ts'

function openBrokerFile(): { broker: PeerSyncBroker; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'peer-sync-'))
  const dbPath = join(root, '.omp', 'peer-sync.sqlite')
  const broker = new PeerSyncBroker(dbPath, '/repo')
  onTestFinished(() => {
    broker.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { broker, dbPath }
}

describe('peerSyncBroker', () => {
  it('keeps the coordination database readable by its owner only', () => {
    const { broker, dbPath } = openBrokerFile()
    broker.registerPeer('peer-a')

    expect(statSync(join(dbPath, '..')).mode & 0o777).toBe(0o700)
    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
    expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600)
  })

  it('prunes peers whose process has exited', () => {
    const { broker, dbPath } = openBrokerFile()
    const crashedPeer = spawnSync(process.execPath, [
      join(import.meta.dirname, 'register-peer.ts'),
      dbPath,
      'peer-crashed',
    ])
    expect(crashedPeer.status).toBe(0)

    broker.registerPeer('peer-alive')

    expect(broker.listOtherPeers('observer').map(peer => peer.peerId)).toEqual(['peer-alive'])
  })

  it('initializes cleanly when multiple peer processes open a brand-new database concurrently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peer-sync-race-'))
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    const dbPath = join(root, '.omp', 'peer-sync.sqlite')
    const script = join(import.meta.dirname, 'register-peer.ts')

    const codes = await Promise.all(
      Array.from({ length: 6 }, async (_, index) => {
        const child = spawn(process.execPath, [script, dbPath, `peer-${index}`], { stdio: 'ignore' })
        return new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
      }),
    )
    expect(codes).toEqual([0, 0, 0, 0, 0, 0])
  })
})
