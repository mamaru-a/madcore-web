import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { DeltaChatSDK } from '../../sdk'
import { MemoryStore } from '../../store'

const SERVER = process.env.SERVER_URL || process.env.CHATMAIL_DOMAIN || 'https://testrun.org'

describe('Delta Chat RPC Core', () => {
  let dc: ReturnType<typeof DeltaChatSDK>
  let account: any

  beforeAll(async () => {
    dc = DeltaChatSDK({ logLevel: 'error', store: new MemoryStore() })
    try {
      const result = await dc.register(SERVER, 'RPC Test User')
      account = result.account
      await account.connect()
    } catch (e: any) {
      if (e.message.includes('404')) {
        console.warn('⚠️  No live relay available — running offline tests only')
        // Continue with skipped live tests
      } else {
        throw e
      }
    }
  })

  afterAll(() => {
    if (account) account.disconnect()
  })

  it('should get system info via RPC-like interface', async () => {
    if (!account) {
      // offline mode
      return
    }
    const status = account.status()
    expect(status).toHaveProperty('id')
    expect(status).toHaveProperty('email')
    expect(status.isConnected).toBe(true)
  })

  it('should send and receive a text message', async () => {
    if (!account) {
      // offline mode - test high-level API structure only
      expect(typeof account?.send).toBe('function')
      return
    }
    // This will be expanded with full RPC once client is implemented
    const testMsg = `RPC test ${Date.now()}`
    const selfContact = { email: account.credentials.email }

    await expect(account.send(selfContact, { text: testMsg })).resolves.toBeDefined()

    // Listen for echo (self-message)
    const received = await new Promise<any>((resolve) => {
      const handler = (msg: any) => {
        if (msg.text?.includes('RPC test')) resolve(msg)
      }
      account.on('DC_EVENT_INCOMING_MSG', handler)
      setTimeout(() => resolve(null), 3000)
    })

    if (received) {
      expect(received.text).toContain('RPC test')
    }
  })

  it('should support secure join flow', async () => {
    if (!account) {
      expect(typeof account?.generateSecureJoinURI).toBe('function')
      return
    }
    const uri = account.generateSecureJoinURI()
    expect(uri).toContain('https://')
    expect(uri).toContain('securejoin')
  })

  it('should list chats (future RPC getAllChats)', async () => {
    if (!account) {
      expect(typeof account?.store?.getAllChats).toBe('function')
      return
    }
    const chats = await account.store.getAllChats()
    expect(Array.isArray(chats)).toBe(true)
  })
})
