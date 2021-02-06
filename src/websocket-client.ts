import { EventEmitter } from 'events';
import { InverseClient } from './inverse-client';
import { LinearClient } from './linear-client';
import { DefaultLogger, Logger } from './logger';
import { signMessage, serializeParams } from './util/requestUtils';

import WebSocket from 'isomorphic-ws';
import WsStore from './util/WsStore';

const inverseEndpoints = {
  livenet: 'wss://stream.bybit.com/realtime',
  testnet: 'wss://stream-testnet.bybit.com/realtime'
};

const linearEndpoints = {
  livenet: 'wss://stream.bybit.com/realtime_public',
  testnet: 'wss://stream-testnet.bybit.com/realtime_public'
};

const loggerCategory = { category: 'bybit-ws' };

const READY_STATE_INITIAL = 0;
const READY_STATE_CONNECTING = 1;
const READY_STATE_CONNECTED = 2;
const READY_STATE_CLOSING = 3;
const READY_STATE_RECONNECTING = 4;

export enum WsConnectionState {
  READY_STATE_INITIAL,
  READY_STATE_CONNECTING,
  READY_STATE_CONNECTED,
  READY_STATE_CLOSING,
  READY_STATE_RECONNECTING
};

const isWsPong = (response: any) => {
  return (
    response.request &&
    response.request.op === 'ping' &&
    response.ret_msg === 'pong' &&
    response.success === true
  );
}

export interface WSClientConfigurableOptions {
  key?: string;
  secret?: string;
  livenet?: boolean;
  linear?: boolean;
  pongTimeout?: number;
  pingInterval?: number;
  reconnectTimeout?: number;
  restOptions?: any;
  requestOptions?: any;
  wsUrl?: string;
};

export interface WebsocketClientOptions extends WSClientConfigurableOptions {
  livenet: boolean;
  linear: boolean;
  pongTimeout: number;
  pingInterval: number;
  reconnectTimeout: number;
};

export const defaultWsKey = 'inverse';

const getLinearWsKeyForTopic = (topic: string) => {
  switch (topic) {
    case '':
      return 'public';

    default:
      return 'private'
  }
}

export class WebsocketClient extends EventEmitter {
  private logger: Logger;
  private client: InverseClient | LinearClient;
  private options: WebsocketClientOptions;

  private wsStore: WsStore;

  constructor(options: WSClientConfigurableOptions, logger?: Logger) {
    super();

    this.logger = logger || DefaultLogger;
    this.wsStore = new WsStore(this.logger);

    this.options = {
      livenet: false,
      linear: false,
      pongTimeout: 1000,
      pingInterval: 10000,
      reconnectTimeout: 500,
      ...options
    };

    if (this.options.linear === true) {
      this.client = new LinearClient(undefined, undefined, this.isLivenet(), this.options.restOptions, this.options.requestOptions);
    } else {
      this.client = new InverseClient(undefined, undefined, this.isLivenet(), this.options.restOptions, this.options.requestOptions);
    }

    this.setWsState(defaultWsKey, READY_STATE_INITIAL);
    this.connect(defaultWsKey);
  }

  public isLivenet(): boolean {
    return this.options.livenet === true;
  }

  public isInverse(): boolean {
    return !this.options.linear;
  }

  /**
   * Add topic/topics to WS subscription list
   */
  public subscribe(wsTopics: string[] | string) {
    const topics = Array.isArray(wsTopics) ? wsTopics : [wsTopics];
    topics.forEach(topic => this.wsStore.addTopic(
      this.getWsKeyForTopic(topic),
      topic
    ));

    // subscribe not necessary if not yet connected (will automatically subscribe onOpen)
    if (this.wsStore.isConnectionState(defaultWsKey, READY_STATE_CONNECTED)) {
      this.wsStore.getKeys().forEach(wsKey =>
        this.requestSubscribeTopics(wsKey, [...this.wsStore.getTopics(wsKey)])
      );
    }
  }

  /**
   * Remove topic/topics from WS subscription list
   */
  public unsubscribe(wsTopics: string[] | string) {
    const topics = Array.isArray(wsTopics) ? wsTopics : [wsTopics];
    topics.forEach(topic => this.wsStore.deleteTopic(
      this.getWsKeyForTopic(topic),
      topic
    ));

    // unsubscribe not necessary if not yet connected
    if (this.wsStore.isConnectionState(defaultWsKey, READY_STATE_CONNECTED)) {
      this.wsStore.getKeys().forEach(wsKey =>
        this.requestUnsubscribeTopics(wsKey, [...this.wsStore.getTopics(wsKey)])
      );
    }
  }

  public close(wsKey: string = defaultWsKey) {
    this.logger.info('Closing connection', loggerCategory);
    this.setWsState(wsKey, READY_STATE_CLOSING);
    this.clearTimers(wsKey);

    this.getWs(wsKey)?.close();
  }

  private async connect(wsKey: string = defaultWsKey): Promise<WebSocket | void> {
    try {
      if (this.wsStore.isWsOpen(wsKey)) {
        this.logger.error('Refused to connect to ws with existing active connection', { ...loggerCategory, wsKey })
        return this.wsStore.getWs(wsKey);
      }

      if (this.wsStore.isConnectionState(wsKey, READY_STATE_CONNECTING)) {
        this.logger.error('Refused to connect to ws, connection attempt already active', { ...loggerCategory, wsKey })
        return;
      }

      if (
        !this.wsStore.getConnectionState(wsKey) ||
        this.wsStore.isConnectionState(wsKey, READY_STATE_INITIAL)
      ) {
        this.setWsState(wsKey, READY_STATE_CONNECTING);
      }

      const authParams = await this.getAuthParams();
      const url = this.getWsUrl() + authParams;
      const ws = this.connectToWsUrl(url, wsKey);

      return this.wsStore.setWs(wsKey, ws);
    } catch (err) {
      this.parseWsError('Connection failed', err, wsKey);
      this.reconnectWithDelay(wsKey, this.options.reconnectTimeout!);
    }
  }

  private parseWsError(context: string, error, wsKey?: string) {
    if (!error.message) {
      this.logger.error(`${context} due to unexpected error: `, error);
      return;
    }

    switch (error.message) {
      case 'Unexpected server response: 401':
        this.logger.error(`${context} due to 401 authorization failure.`, loggerCategory);
        break;

      default:
        this.logger.error(`{context} due to unexpected response error: ${error.msg}`);
        break;
    }
  }

  /**
   * Return params required to make authorized request
   */
  private async getAuthParams(): Promise<string> {
    const { key, secret } = this.options;

    if (key && secret) {
      this.logger.debug('Getting auth\'d request params', loggerCategory);

      const timeOffset = await this.client.getTimeOffset();

      const params: any = {
        api_key: this.options.key,
        expires: (Date.now() + timeOffset + 5000)
      };

      params.signature = signMessage('GET/realtime' + params.expires, secret);
      return '?' + serializeParams(params);

    } else if (!key || !secret) {
      this.logger.warning('Connot authenticate websocket, either api or private keys missing.', loggerCategory);
    } else {
      this.logger.debug('Starting public only websocket client.', loggerCategory);
    }

    return '';
  }

  private reconnectWithDelay(wsKey: string = defaultWsKey, connectionDelayMs: number) {
    this.clearTimers(wsKey);
    if (this.wsStore.getConnectionState(wsKey) !== READY_STATE_CONNECTING) {
      this.setWsState(wsKey, READY_STATE_RECONNECTING);
    }

    setTimeout(() => {
      this.logger.info('Reconnecting to server', loggerCategory);
      this.connect();
    }, connectionDelayMs);
  }

  private ping(wsKey: string = defaultWsKey) {
    this.clearPongTimer(wsKey);

    this.logger.silly('Sending ping', loggerCategory);
    this.tryWsSend(wsKey, JSON.stringify({ op: 'ping' }));

    this.wsStore.get(wsKey, true)!.activePongTimer = setTimeout(() => {
      this.logger.info('Pong timeout - closing socket to reconnect', loggerCategory);
      this.getWs(wsKey)?.close();
    }, this.options.pongTimeout);
  }

  private clearTimers(wsKey: string) {
    this.clearPingTimer(wsKey);
    this.clearPongTimer(wsKey);
  }

  // Send a ping at intervals
  private clearPingTimer(wsKey: string) {
    const wsState = this.wsStore.get(wsKey);
    if (wsState?.activePingTimer) {
      clearInterval(wsState.activePingTimer);
      wsState.activePingTimer = undefined;
    }
  }

  // Expect a pong within a time limit
  private clearPongTimer(wsKey: string) {
    const wsState = this.wsStore.get(wsKey);
    if (wsState?.activePongTimer) {
      clearTimeout(wsState.activePongTimer);
      wsState.activePongTimer = undefined;
    }
  }

  /**
   * Send WS message to subscribe to topics.
   */
  private requestSubscribeTopics(wsKey: string, topics: string[]) {
    const wsMessage = JSON.stringify({
      op: 'subscribe',
      args: topics
    });

    this.tryWsSend(wsKey, wsMessage);
  }

  /**
   * Send WS message to unsubscribe from topics.
   */
  private requestUnsubscribeTopics(wsKey: string, topics: string[]) {
    const wsMessage = JSON.stringify({
      op: 'unsubscribe',
      args: topics
    });

    this.tryWsSend(wsKey, wsMessage);
  }

  private tryWsSend(wsKey: string, wsMessage: string) {
    try {
      this.getWs(wsKey)?.send(wsMessage);
    } catch (e) {
      this.logger.error(`Failed to send WS message`, { ...loggerCategory, wsMessage, wsKey, exception: e });
    }
  }

  private connectToWsUrl(url: string, wsKey: string): WebSocket {
    const ws = new WebSocket(url);

    ws.onopen = event => this.onWsOpen(event, wsKey);
    ws.onmessage = event => this.onWsMessage(event, wsKey);
    ws.onerror = event => this.onWsError(event, wsKey);
    ws.onclose = event => this.onWsClose(event, wsKey);

    return ws;
  }

  private onWsOpen(event, wsKey: string = defaultWsKey) {
    if (this.wsStore.isConnectionState(wsKey, READY_STATE_CONNECTING)) {
      this.logger.info('Websocket connected', { ...loggerCategory, livenet: this.options.livenet, linear: this.options.linear });
      this.emit('open');
    } else if (this.wsStore.isConnectionState(wsKey, READY_STATE_RECONNECTING)) {
      this.logger.info('Websocket reconnected', { ...loggerCategory });
      this.emit('reconnected');
    }

    this.setWsState(wsKey, READY_STATE_CONNECTED);

    this.wsStore.getKeys().forEach(wsKey =>
      this.requestSubscribeTopics(wsKey, [...this.wsStore.getTopics(wsKey)])
    );

    this.wsStore.get(wsKey, true)!.activePingTimer = setInterval(
      this.ping.bind(this),
      this.options.pingInterval
    );
  }

  private onWsMessage(event, wsKey: string) {
    const msg = JSON.parse(event && event.data || event);

    if ('success' in msg) {
      this.onWsMessageResponse(msg, wsKey);
    } else if (msg.topic) {
      this.onWsMessageUpdate(msg);
    } else {
      this.logger.warning('Got unhandled ws message', msg);
    }
  }

  private onWsError(err, wsKey: string = defaultWsKey) {
    this.parseWsError('Websocket error', err, wsKey);
    if (this.wsStore.isConnectionState(wsKey, READY_STATE_CONNECTED)) {
      this.emit('error', err);
    }
  }

  private onWsClose(event, wsKey: string = defaultWsKey) {
    this.logger.info('Websocket connection closed', loggerCategory);

    if (this.wsStore.getConnectionState(wsKey) !== READY_STATE_CLOSING) {
      this.reconnectWithDelay(wsKey, this.options.reconnectTimeout!);
      this.emit('reconnect');
    } else {
      this.setWsState(wsKey, READY_STATE_INITIAL);
      this.emit('close');
    }
  }

  private onWsMessageResponse(response: any, wsKey: string) {
    if (isWsPong(response)) {
      this.logger.silly('Received pong', loggerCategory);
      this.clearPongTimer(wsKey);
    } else {
      this.emit('response', response);
    }
  }

  private onWsMessageUpdate(message: any) {
    this.emit('update', message);
  }

  private getWs(wsKey: string) {
    return this.wsStore.getWs(wsKey);
  }

  private setWsState(wsKey: string, state: WsConnectionState) {
    this.wsStore.setConnectionState(wsKey, state);
  }

  private getWsUrl(): string {
    if (this.options.wsUrl) {
      return this.options.wsUrl;
    }
    if (this.options.linear){
      return linearEndpoints[this.options.livenet ? 'livenet' : 'testnet'];
    }
    return inverseEndpoints[this.options.livenet ? 'livenet' : 'testnet'];
  }

  private getWsKeyForTopic(topic: string) {
    return this.isInverse() ? defaultWsKey : getLinearWsKeyForTopic(topic);
  }
};
