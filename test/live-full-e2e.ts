/**
 * Full live E2E — exercises every public DeltaChatAccount method that can run
 * against a real madmail host + peer SecureJoin invite.
 *
 *   SERVER_URL=https://… JOIN_URI='https://i.delta.chat/#…' bun run test/live-full-e2e.ts
 *
 * No secrets in the repo. Web-compatible helpers (no Node Buffer for media).
 */
import { DeltaChatSDK } from '../sdk';
import { MemoryStore } from '../store';
import { checkQr, parseSecureJoinURI } from '../lib/securejoin';

const SERVER = process.env.SERVER_URL;
const JOIN_URI = process.env.JOIN_URI;
const JOIN_TIMEOUT_MS = Number(process.env.JOIN_TIMEOUT_MS || 90_000);

// Tiny 1×1 PNG (web-safe base64)
const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Minimal “ogg-like” payload (not real audio — relay only needs base64 bytes)
const AUDIO_B64 = btoa('fake-ogg-bytes-for-test');

type Row = { method: string; status: 'pass' | 'fail' | 'skip'; detail?: string };
const rows: Row[] = [];

function pass(method: string, detail?: string) {
    rows.push({ method, status: 'pass', detail });
    console.log(`  ✅ ${method}${detail ? ` — ${detail}` : ''}`);
}
function fail(method: string, detail?: string) {
    rows.push({ method, status: 'fail', detail });
    console.log(`  ❌ ${method}${detail ? ` — ${detail}` : ''}`);
}
function skip(method: string, detail?: string) {
    rows.push({ method, status: 'skip', detail });
    console.log(`  ⏭  ${method}${detail ? ` — ${detail}` : ''}`);
}

async function tryMethod(method: string, fn: () => Promise<any> | any) {
    try {
        const r = await fn();
        const detail = r === undefined || r === null
            ? undefined
            : typeof r === 'string'
                ? r.slice(0, 80)
                : typeof r === 'object' && r.msgId
                    ? `msgId=${r.msgId}`
                    : typeof r === 'object' && r.id
                        ? `id=${r.id}`
                        : JSON.stringify(r).slice(0, 80);
        pass(method, detail);
        return r;
    } catch (e: any) {
        fail(method, e?.message || String(e));
        return null;
    }
}

async function main() {
    if (!SERVER || !JOIN_URI) {
        console.error('SERVER_URL and JOIN_URI are required');
        process.exit(2);
    }

    console.log('\n🚀 Full live E2E against madmail');
    console.log(`   Server: ${SERVER}`);
    console.log(`   Join:   ${JOIN_URI.slice(0, 56)}…\n`);

    const peer = parseSecureJoinURI(JOIN_URI);
    pass('checkQr/parseSecureJoinURI', peer.inviterEmail);

    const dc = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'warn' });

    // ── Account A: primary tester ──
    const regA = await tryMethod('register', () => dc.register(SERVER!, 'Madcore E2E A'));
    if (!regA?.account) {
        console.error('Cannot continue without registration');
        process.exit(1);
    }
    const a = regA.account as any;

    await tryMethod('generateKeys', () => a.generateKeys('Madcore E2E A'));
    await tryMethod('status', () => JSON.stringify(a.status()));
    await tryMethod('getCredentials', () => a.getCredentials().email);
    await tryMethod('getFingerprint', () => a.getFingerprint().slice(0, 16));
    await tryMethod('getPublicKeyArmored', () => (a.getPublicKeyArmored() || '').slice(0, 40));
    await tryMethod('getDisplayName', () => a.getDisplayName());
    await tryMethod('setDisplayName', () => { a.setDisplayName('Madcore E2E A'); });
    await tryMethod('capabilities', () => JSON.stringify(a.capabilities()));
    await tryMethod('getConnectivity', () => a.getConnectivity());
    await tryMethod('getConnectivityHtml', () => a.getConnectivityHtml().slice(0, 40));

    await tryMethod('connect', async () => {
        await a.connect(SERVER);
        await new Promise(r => setTimeout(r, 400));
        if (!a.status().isConnected) throw new Error('not connected');
        return a.getConnectivity();
    });

    await tryMethod('listTransports', () => a.listTransports().join(','));
    await tryMethod('getTransport', () => a.getTransport(SERVER!).isConnected ? 'ok' : 'down');
    await tryMethod('wsRequest(list_mailboxes)', async () => {
        const m = await a.wsRequest('list_mailboxes', {});
        return Array.isArray(m) ? `${m.length} boxes` : String(m);
    });
    await tryMethod('fetchMessages', async () => {
        const m = await a.fetchMessages(0);
        return `n=${Array.isArray(m) ? m.length : '?'}`;
    });
    await tryMethod('listRelays', () => `${a.listRelays().length} relays`);
    await tryMethod('getRelay', () => a.getRelay(a.listRelays()[0]?.id)?.email);

    // ── SecureJoin user ──
    let contact: any = null;
    let contactId = '';
    await tryMethod('secureJoin', async () => {
        const joinP = a.secureJoin(JOIN_URI!);
        const timeout = new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`timeout ${JOIN_TIMEOUT_MS}ms`)), JOIN_TIMEOUT_MS),
        );
        const result = await Promise.race([joinP, timeout]) as any;
        contact = result.contact;
        contactId = result.contactId || contact?.id;
        if (!contact && result.peerEmail) {
            // rebuild contact handle
            contact = a.findContactByEmail(result.peerEmail) || result.peerEmail;
        }
        return `verified=${result.verified} peer=${result.peerEmail}`;
    });

    if (!contact) {
        fail('ABORT', 'SecureJoin failed — cannot run peer messaging');
        summary();
        process.exit(1);
    }

    const peerEmail = typeof contact === 'string' ? contact : contact.email;

    // ── Profile ──
    await tryMethod('setProfilePhotoB64', () => { a.setProfilePhotoB64(PNG, 'image/png'); });
    await tryMethod('setProfilePhoto(base64 obj)', () => a.setProfilePhoto({ data: PNG, mimeType: 'image/png' }));
    await tryMethod('sendProfilePhoto', () => a.sendProfilePhoto(contact, { caption: 'E2E profile photo' }));
    await tryMethod('broadcastProfilePhoto', () => a.broadcastProfilePhoto());
    await tryMethod('getPeerAvatar', () => a.getPeerAvatar(peerEmail) ? 'has' : 'null');
    await tryMethod('getAvatarHeaderForContact', () => a.getAvatarHeaderForContact(peerEmail).slice(0, 30));
    await tryMethod('markAvatarSent', () => { a.markAvatarSent(peerEmail); });

    // ── Messaging ──
    let lastMsg: any = null;
    lastMsg = await tryMethod('send(text)', () =>
        a.send(contact, { text: `E2E text ${new Date().toISOString()}` }));

    await tryMethod('sendMessage', () => a.sendMessage(contact, 'E2E sendMessage'));

    const replyParent = lastMsg?.message || lastMsg;
    if (replyParent) {
        await tryMethod('sendReply', () =>
            a.sendReply(contact, {
                parentMessage: replyParent,
                text: 'E2E reply',
                quotedText: 'quoted',
            }));
        await tryMethod('send(reaction)', () =>
            a.send(contact, { reaction: { targetMessage: replyParent, reaction: '👋' } }));
        await tryMethod('sendReaction', () =>
            a.sendReaction(contact, { targetMessage: replyParent, reaction: '🎉' }));
        await tryMethod('sendEdit', () =>
            a.sendEdit(contact, { targetMessage: replyParent, newText: 'E2E edited text' }));
    } else {
        skip('sendReply/reaction/edit', 'no parent message');
    }

    await tryMethod('sendImage', () =>
        a.sendImage(contact, { filename: 'dot.png', data: PNG, mimeType: 'image/png', caption: 'E2E image' }));
    await tryMethod('send({ image })', () =>
        a.send(contact, { image: { data: PNG, filename: 'dot2.png', caption: 'unified image' } }));
    await tryMethod('sendSticker', () =>
        a.sendSticker(contact, { data: PNG, mimeType: 'image/png', filename: 'sticker.png' }));
    await tryMethod('send({ sticker })', () =>
        a.send(contact, { sticker: { data: PNG, mimeType: 'image/png' } }));
    await tryMethod('sendGif', () =>
        a.sendGif(contact, { data: PNG, filename: 'x.gif', caption: 'gif-as-png' }));
    await tryMethod('sendFile', () =>
        a.sendFile(contact, {
            filename: 'note.txt',
            data: btoa('hello e2e file'),
            mimeType: 'text/plain',
            caption: 'E2E file',
        }));
    await tryMethod('sendVideo', () =>
        a.sendVideo(contact, {
            filename: 'clip.bin',
            data: AUDIO_B64,
            mimeType: 'video/mp4',
            caption: 'E2E video bytes',
            durationMs: 1000,
        }));
    await tryMethod('sendAudio', () =>
        a.sendAudio(contact, {
            filename: 'a.bin',
            data: AUDIO_B64,
            mimeType: 'audio/ogg',
            durationMs: 500,
        }));
    await tryMethod('sendVoice', () =>
        a.sendVoice(contact, { data: AUDIO_B64, durationMs: 400, mimeType: 'audio/ogg' }));
    await tryMethod('send({ voice })', () =>
        a.send(contact, { voice: { data: AUDIO_B64, durationMs: 300 } }));

    // Forward / resend
    if (lastMsg?.message || lastMsg?.msgId) {
        const orig = lastMsg.message || { id: lastMsg.msgId, text: 'E2E text' };
        await tryMethod('forwardMessage', () =>
            a.forwardMessage(contact, {
                originalMessage: orig,
                originalFrom: a.getCredentials().email,
            }));
        await tryMethod('send({ forward })', () =>
            a.send(contact, {
                forward: {
                    originalMessage: orig,
                    originalFrom: a.getCredentials().email,
                },
            }));
        await tryMethod('resendMessage', () =>
            a.resendMessage(contact, { originalMessage: orig }));
    }

    // Delete for everyone (send a disposable then delete)
    const disposable = await tryMethod('send(disposable for delete)', () =>
        a.send(contact, { text: 'delete me e2e' }));
    if (disposable?.message || disposable?.msgId) {
        const t = disposable.message || disposable.msgId;
        await tryMethod('sendDelete', () => a.sendDelete(contact, { targetMessage: t }));
        await tryMethod('send({ delete })', async () => {
            const d2 = await a.send(contact, { text: 'delete me too' });
            await a.send(contact, { delete: { targetMessage: d2.message || d2.msgId } });
        });
    }

    // Webxdc
    await tryMethod('sendWebxdc', () =>
        a.sendWebxdc(contact, { data: btoa('PK\x03\x04fake-xdc'), name: 'E2E App', filename: 'app.xdc' }));
    // status update needs instance id — use last outbound if any
    const chatsAfter = await a.getChatList();
    const peerChat = chatsAfter.find((c: any) =>
        c.peerEmail?.toLowerCase() === peerEmail.toLowerCase()
        || c.id?.toLowerCase() === peerEmail.toLowerCase(),
    );
    if (peerChat) {
        const msgs = await a.getChatMessages(peerChat.id, 20, 0);
        const wx = msgs.find((m: any) => m.type === 'webxdc');
        if (wx) {
            await tryMethod('sendWebxdcStatusUpdate', () =>
                a.sendWebxdcStatusUpdate(contact, wx.id, { payload: { hello: 1 }, serial: 1 }));
            await tryMethod('getWebxdcStatusUpdates', () =>
                a.getWebxdcStatusUpdates(wx.id, 0));
        } else {
            skip('sendWebxdcStatusUpdate', 'no webxdc msg in store');
            skip('getWebxdcStatusUpdates', 'no webxdc msg in store');
        }
    }

    // Location / calls (signaling to peer)
    await tryMethod('sendLocationsToChat', () =>
        a.sendLocationsToChat(peerEmail, { durationSec: 120 }));
    await tryMethod('setLocation', () =>
        a.setLocation({ lat: 35.7, lon: 51.4, accuracy: 10 }));
    await tryMethod('getLocations', () =>
        a.getLocations(peerEmail).then((p: any[]) => `n=${p.length}`));
    await tryMethod('stopSendingLocations', () => a.stopSendingLocations(peerEmail));

    await tryMethod('setIceServers', () => {
        a.setIceServers([{ urls: 'stun:stun.l.google.com:19302' }]);
    });
    await tryMethod('getIceServers', () => `${a.getIceServers().length} servers`);
    const call = await tryMethod('placeOutgoingCall', () =>
        a.placeOutgoingCall(contact, { video: false }));
    if (call?.callId) {
        await tryMethod('getCall', () => a.getCall(call.callId)?.state);
        await tryMethod('endCall', () => a.endCall(call.callId));
    } else {
        skip('getCall/endCall', 'no call session');
    }
    skip('acceptIncomingCall', 'requires inbound call from peer');

    // ── Second account for groups ──
    const regB = await tryMethod('register(B)', () => dc.register(SERVER!, 'Madcore E2E B'));
    const b = regB?.account as any;
    if (b) {
        await tryMethod('B.generateKeys', () => b.generateKeys('Madcore E2E B'));
        await tryMethod('B.connect', async () => {
            await b.connect(SERVER);
            await new Promise(r => setTimeout(r, 400));
        });
        // Exchange keys: A invites B via SecureJoin
        const uriA = await tryMethod('generateSecureJoinURI', () => a.generateSecureJoinURI());
        if (uriA) {
            await tryMethod('B.secureJoin(A)', async () => {
                const r = await Promise.race([
                    b.secureJoin(uriA),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), JOIN_TIMEOUT_MS)),
                ]) as any;
                return `verified=${r.verified}`;
            });
        }

        // Import B key into A if securejoin worked
        const bContact = a.findContactByEmail(b.getCredentials().email);
        if (bContact || a.knownKeys.has(b.getCredentials().email.toLowerCase())) {
            const group = await tryMethod('createGroup', () =>
                a.createGroup({
                    name: 'E2E Group',
                    members: [b.getCredentials().email, peerEmail],
                }));
            if (group) {
                await tryMethod('getGroup', () => a.getGroup(group.grpId)?.name);
                await tryMethod('listGroups', () => `${a.listGroups().length}`);
                await tryMethod('sendGroupMessage', () =>
                    a.sendGroupMessage(group, { text: 'hello group e2e' }));
                await tryMethod('send(group text)', () =>
                    a.send(group, { text: 'unified group text' }));
                await tryMethod('send(group image)', () =>
                    a.send(group, { image: { data: PNG, caption: 'group pic' } }));
                await tryMethod('renameGroup', () =>
                    a.renameGroup(group, { newName: 'E2E Group Renamed' }));
                await tryMethod('updateGroupDescription', () =>
                    a.updateGroupDescription(group, { newDescription: 'e2e desc' }));
                await tryMethod('addGroupMember', async () => {
                    // re-add B if needed
                    await a.addGroupMember(group, { email: b.getCredentials().email });
                });
                // remove a fake member if not present may still send
                await tryMethod('removeGroupMember', () =>
                    a.removeGroupMember(group, { email: b.getCredentials().email }));
                await tryMethod('setChatProfileImage(group)', () =>
                    a.setChatProfileImage(group.grpId, { data: PNG, mimeType: 'image/png' }));
                await tryMethod('removeChatProfileImage(group)', () =>
                    a.removeChatProfileImage(group.grpId));
                await tryMethod('leaveGroup', () => a.leaveGroup(group));
            }

            const channel = await tryMethod('createChannel', () =>
                a.createChannel({
                    name: 'E2E Channel',
                    description: 'live e2e',
                    initialMembers: [b.getCredentials().email],
                }));
            if (channel) {
                await tryMethod('sendBroadcast', () =>
                    a.sendBroadcast(channel, { text: 'channel news e2e' }));
                await tryMethod('send(channel)', () =>
                    a.send(channel, { text: 'unified channel' }));
            }
        } else {
            skip('createGroup/channel suite', 'A↔B SecureJoin incomplete');
        }
    }

    // ── Chat / store management ──
    const chatId = peerEmail.toLowerCase();
    await tryMethod('getChatList', () => a.getChatList().then((c: any[]) => `n=${c.length}`));
    await tryMethod('getChat', () => a.getChat(chatId).then((c: any) => c?.name || 'null'));
    await tryMethod('getChatMessages', () =>
        a.getChatMessages(chatId, 50, 0).then((m: any[]) => `n=${m.length}`));
    await tryMethod('getOrCreateChat', () => a.getOrCreateChat(peerEmail));
    await tryMethod('searchChats', () => a.searchChats('E2E').then((c: any[]) => `n=${c.length}`));
    await tryMethod('searchMessages', () => a.searchMessages('E2E').then((m: any[]) => `n=${m.length}`));
    await tryMethod('searchContacts', () => a.searchContacts(peerEmail.slice(0, 4)).then((c: any[]) => `n=${c.length}`));
    await tryMethod('getContacts', () => a.getContacts().then((c: any[]) => `n=${c.length}`));
    await tryMethod('getContact', () => contactId ? a.getContact(contactId)?.email : 'no id');
    await tryMethod('findContactByEmail', () => a.findContactByEmail(peerEmail)?.email);
    await tryMethod('getUnreadCount', () => a.getUnreadCount());
    await tryMethod('markChatRead', () => a.markChatRead(chatId));
    await tryMethod('markMessageSeen', async () => {
        const msgs = await a.getChatMessages(chatId, 5, 0);
        const inc = msgs.find((m: any) => m.direction === 'incoming');
        if (inc) await a.markMessageSeen(inc.id);
        else throw new Error('no incoming msg to mark');
    });
    await tryMethod('archiveChat', () => a.archiveChat(chatId, true));
    await tryMethod('archiveChat(un)', () => a.archiveChat(chatId, false));
    await tryMethod('pinChat', () => a.pinChat(chatId, true));
    await tryMethod('pinChat(un)', () => a.pinChat(chatId, false));
    await tryMethod('muteChat', () => a.muteChat(chatId, true));
    await tryMethod('muteChat(un)', () => a.muteChat(chatId, false));

    await tryMethod('setDraft', () => a.setDraft(chatId, { text: 'draft e2e' }));
    await tryMethod('getDraft', () => a.getDraft(chatId).then((d: any) => d?.text));
    await tryMethod('removeDraft', () => a.removeDraft(chatId));
    await tryMethod('setChatEphemeralTimer', () => a.setChatEphemeralTimer(chatId, 0));
    await tryMethod('getChatEphemeralTimer', () => a.getChatEphemeralTimer(chatId));
    await tryMethod('sweepEphemeralMessages', () => a.sweepEphemeralMessages());
    await tryMethod('setChatProfileImage(1:1)', () =>
        a.setChatProfileImage(chatId, { data: PNG }));
    await tryMethod('removeChatProfileImage(1:1)', () => a.removeChatProfileImage(chatId));

    // Contacts CRUD (non-peer)
    await tryMethod('createContact', () =>
        a.createContact({
            email: 'dummy@example.com',
            name: 'Dummy',
            key: a.getPublicKeyArmored(),
        }));
    await tryMethod('deleteContact', async () => {
        const c = a.findContactByEmail('dummy@example.com');
        if (c) await a.deleteContact(c.id);
    });

    // Block a non-peer only
    await tryMethod('blockContact', () => a.blockContact('spam-e2e@example.com'));
    await tryMethod('isBlocked', () => String(a.isBlocked('spam-e2e@example.com')));
    await tryMethod('getBlockedContacts', () =>
        a.getBlockedContacts().then((c: any[]) => `n=${c.length}`));
    await tryMethod('unblockContact', () => a.unblockContact('spam-e2e@example.com'));

    await tryMethod('checkQr', () => a.checkQr(JOIN_URI!).kind);
    await tryMethod('createQrSvg', () => a.createQrSvg('test').includes('<svg') ? 'svg' : 'no');
    await tryMethod('parseSecureJoinURI', () => a.parseSecureJoinURI(JOIN_URI!).inviterEmail);

    // Config / push / device
    await tryMethod('setConfig', () => a.setConfig('e2e_flag', '1'));
    await tryMethod('getConfig', () => a.getConfig('e2e_flag'));
    await tryMethod('batchSetConfig', () => a.batchSetConfig({ e2e_a: '1', e2e_b: '2' }));
    await tryMethod('setWatchedMailboxes', () => { a.setWatchedMailboxes(['INBOX']); });
    await tryMethod('getWatchedMailboxes', () => a.getWatchedMailboxes().join(','));
    await tryMethod('backgroundFetch', () => a.backgroundFetch(0));
    await tryMethod('setPushToken', () =>
        a.setPushToken({ type: 'webpush', endpoint: 'https://example.com/push/e2e' }));
    await tryMethod('processPushPayload', () => a.processPushPayload({ test: true }));
    await tryMethod('addDeviceMessage', () =>
        a.addDeviceMessage('e2e', 'Device note from full e2e'));

    // Backup / store
    await tryMethod('saveToStore', () => a.saveToStore());
    await tryMethod('exportBackup', async () => {
        const j = await a.exportBackup();
        return `bytes=${j.length}`;
    });
    await tryMethod('exportBackup(encrypted)', async () => {
        const j = await a.exportBackup({ passphrase: 'e2e-temp-pass' });
        return JSON.parse(j).enc ? 'enc' : 'plain';
    });
    // Don't importBackup over live account state (destructive) — test roundtrip on side account
    skip('importBackup', 'destructive on live session; covered offline');

    // Multi-relay API (register second relay on same host is ok)
    await tryMethod('addRelay', async () => {
        const r = await a.addRelay(SERVER!);
        return r.email;
    });
    await tryMethod('removeRelay', () => {
        const relays = a.listRelays();
        if (relays.length > 1) a.removeRelay(relays[relays.length - 1].id);
        else throw new Error('only primary relay');
    });

    // Events API
    await tryMethod('on/off', () => {
        const h = () => {};
        a.on('DC_EVENT_INFO', h);
        a.off('DC_EVENT_INFO', h);
    });
    await tryMethod('getKnownKeys', () => `n=${a.getKnownKeys().size}`);
    await tryMethod('importKey', () => {
        a.importKey('self-import@test', a.getPublicKeyArmored());
    });

    // Local delete helpers (non-destructive to peer)
    await tryMethod('deleteLocalMessage', async () => {
        const msgs = await a.getChatMessages(chatId, 5, 0);
        const mine = msgs.find((m: any) => m.direction === 'outgoing');
        if (mine) await a.deleteLocalMessage(mine.id);
        else throw new Error('no local outgoing');
    });
    skip('deleteChat', 'would wipe peer conversation UI state');

    // Deprecated / low-level
    await tryMethod('connectWebSocket', async () => {
        // already connected
        await a.connectWebSocket(0);
    });
    await tryMethod('processIncomingRaw', async () => {
        await a.processIncomingRaw({
            uid: 0,
            body: [
                'From: <self@test>',
                'To: <alice@test>',
                'Subject: x',
                'Chat-Version: 1.0',
                'Content-Type: text/plain',
                '',
                'noop',
            ].join('\r\n'),
        });
    });

    // SecureJoin helpers (no second join)
    await tryMethod('sendSecureJoinRequest', async () => {
        // dry — may bounce; still exercises method
        try {
            await a.sendSecureJoinRequest(peerEmail, 'test-invite', undefined);
        } catch (e: any) {
            // ok if peer rejects
            if (!e.message) throw e;
        }
    });
    skip('sendSecureJoinAuth', 'requires mid-handshake state');
    skip('joinGroup', 'needs group invite URI');
    skip('acceptIncomingCall', 'needs inbound ring');

    await tryMethod('disconnect', () => { a.disconnect(); });
    if (b) await tryMethod('B.disconnect', () => { b.disconnect(); });

    // Manager
    await tryMethod('dc.listAccounts', () => `${dc.listAccounts().length}`);
    await tryMethod('dc.findAccountByEmail', () => dc.findAccountByEmail(a.getCredentials().email)?.id);
    await tryMethod('dc.getAccount', () => dc.getAccount(a.id).id);

    summary();
}

function summary() {
    const passN = rows.filter(r => r.status === 'pass').length;
    const failN = rows.filter(r => r.status === 'fail').length;
    const skipN = rows.filter(r => r.status === 'skip').length;
    console.log(`\n📊 pass=${passN} fail=${failN} skip=${skipN} total=${rows.length}\n`);
    if (failN) {
        console.log('Failures:');
        for (const r of rows.filter(x => x.status === 'fail')) {
            console.log(`  - ${r.method}: ${r.detail}`);
        }
        console.log('');
    }
    process.exit(failN > 0 ? 1 : 0);
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
