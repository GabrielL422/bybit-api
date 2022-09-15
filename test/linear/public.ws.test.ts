import {
  LinearClient,
  WebsocketClient,
  WSClientConfigurableOptions,
  WS_KEY_MAP,
} from '../../src';
import {
  silentLogger,
  waitForSocketEvent,
  WS_OPEN_EVENT_PARTIAL,
} from '../ws.util';

describe('Public Linear Websocket Client', () => {
  let wsClient: WebsocketClient;

  const wsClientOptions: WSClientConfigurableOptions = {
    market: 'linear',
  };

  beforeAll(() => {
    wsClient = new WebsocketClient(wsClientOptions, silentLogger);
    wsClient.connectPublic();
  });

  afterAll(() => {
    wsClient.closeAll();
  });

  it('should open a private ws connection', async () => {
    const wsOpenPromise = waitForSocketEvent(wsClient, 'open');

    expect(wsOpenPromise).resolves.toMatchObject({
      event: WS_OPEN_EVENT_PARTIAL,
      wsKey: WS_KEY_MAP.linearPublic,
    });

    await Promise.all([wsOpenPromise]);
  });

  it('should subscribe to public orderBookL2_25 events', async () => {
    const wsResponsePromise = waitForSocketEvent(wsClient, 'response');
    const wsUpdatePromise = waitForSocketEvent(wsClient, 'update');

    const wsTopic = 'orderBookL2_25.BTCUSDT';
    expect(wsResponsePromise).resolves.toMatchObject({
      request: {
        args: [wsTopic],
        op: 'subscribe',
      },
      success: true,
    });
    expect(wsUpdatePromise).resolves.toMatchObject({
      topic: wsTopic,
      data: {
        order_book: expect.any(Array),
      },
    });

    wsClient.subscribe(wsTopic);

    try {
      await wsResponsePromise;
    } catch (e) {
      console.error(
        `Wait for "${wsTopic}" subscription response exception: `,
        e
      );
    }

    try {
      await wsUpdatePromise;
    } catch (e) {
      console.error(`Wait for "${wsTopic}" event exception: `, e);
    }
  });

  it('should fail to subscribe to private events (no keys)', async () => {
    const wsResponsePromise = waitForSocketEvent(wsClient, 'response');
    // const wsUpdatePromise = waitForSocketEvent(wsClient, 'update');

    const wsTopic = 'wallet';
    expect(wsResponsePromise).resolves.toMatchObject({
      request: {
        args: [wsTopic],
        op: 'subscribe',
      },
      success: true,
    });

    // No easy way to trigger a private event (other than executing trades)
    // expect(wsUpdatePromise).resolves.toMatchObject({
    //   topic: wsTopic,
    //   data: expect.any(Array),
    // });

    wsClient.subscribe(wsTopic);

    await Promise.all([wsResponsePromise]);
  });
});
