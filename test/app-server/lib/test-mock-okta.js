/*!
 * Copyright (c) 2015-2016, Okta, Inc. and/or its affiliates. All rights reserved.
 * The Okta software accompanied by this notice is provided pursuant to the Apache License, Version 2.0 (the "License.")
 *
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0.
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *
 * See the License for the specific language governing permissions and limitations under the License.
 */

/**
 * Simple test server that mocks requests to Okta.
 *
 * Basic flow:
 * 1. Send /mock/set request to prime the expected requests for the test. It
 *    should send a json array of objects representing the requests:
 *    - 'req' property to validate the next request against
 *    - 'res' property that will be sent back after validation passes
 * 2. Make requests to the test server. If 'req' validation passes, it will
 *    return a JSON response with a 'res' response body.
 * 3. Send /mock/done request to clear expectations, and return an error if
 *    any non-optional requests were not invoked.
 */

/* eslint no-param-reassign: 0, no-console:0 */

'use strict';

const http = require('http');
const url = require('url');
const merge = require('lodash.merge');
const connect = require('connect');
const bodyParser = require('body-parser');

const config = require('../../../.samples.config.json');
const wellKnownResponse = require('./well-known');
const keys1 = require('./keys1');

let mocks = [];
let log = [];

function sendResponse(req, res, body) {
  // Add request and response to log
  console.log(`sending response for: ${req.url}`);
  if (req.url.indexOf('/mock') === -1) {
    console.log(`Adding to log: ${req.url}`);
    const headers = {};
    let currentKey;
    for (let i = 0; i < req.rawHeaders.length; i++) {
      if (i % 2 === 0) {
        currentKey = req.rawHeaders[i];
      } else {
        headers[currentKey] = req.rawHeaders[i];
      }
    }
    log.push({
      req: {
        method: req.method,
        url: req.url,
        headers,
      },
      res: body,
    });
  }
  if (typeof body === 'object') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body, null, 2));
  }
  else {
    res.end(body);
  }
}

function handleClearRequest(req, res) {
  log = [];
  mocks = [];
  sendResponse(req, res, {});
}

function handleSetRequest(req, res) {
  mocks = req.body;
  sendResponse(req, res, {});
}

function handleDoneRequest(req, res) {
  let body;
  const required = mocks.find(mock => !mock.optional);
  if (required) {
    body = `Missing required request: ${required.req.url}`;
    res.statusCode = 500;
  } else {
    res.statusCode = 200;
  }
  sendResponse(req, res, body);
}

function handleLogRequest(res) {
  console.log('LOG REQUEST:');
  console.log(log);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(log, null, 2));
}

function handleWellKnownRequest(req, res) {
  sendResponse(req, res, wellKnownResponse);
}

function handleKeysRequest(req, res) {
  const json = {
    keys: [keys1.publicJwk],
  };
  json.keys[0].kid = 'KID_FOO';
  sendResponse(req, res, json);
}

function validateReq(expected, req) {
  Object.keys(expected).forEach((key) => {
    if (key === 'url' || key === 'query') {
      return;
    }
    const expectedVal = expected[key];
    const reqVal = req[key];
    if (expectedVal instanceof Object) {
      validateReq(expectedVal, reqVal);
    } else if (expectedVal !== reqVal) {
      throw new Error(`Expected ${expectedVal}, but got ${reqVal}`);
    }
  });
}

function nextMatchingRequest(req) {
  // 1. If we've run out of requests, throw an error
  if (mocks.length === 0) {
    throw new Error(`Unexpected request: ${req.url}`);
  }

  // 2. Check the baseUrl, and skip the next expected request if its optional
  const expected = mocks.shift();
  const parsed = url.parse(req.url, true);

  const matchesBase = parsed.pathname === expected.req.url;
  if (!matchesBase && expected.optional) {
    return nextMatchingRequest(req);
  }
  if (!matchesBase) {
    const msg = `Expected ${expected.req.url}, but got ${req.url}`;
    throw new Error(msg);
  }

  // 3. Check query parameters
  const expectedQuery = expected.req.query || {};
  const expectedKeys = Object.keys(expectedQuery);

  // The backend does not distinguish between query or post params
  let parsedQuery = parsed.query;
  if (req.method === 'POST') {
    console.log('IS THIS CORRECT ALWAYS? I.E. CLIENT_SECRET...');
    parsedQuery = merge(parsedQuery, req.body);
  }
  const parsedKeys = Object.keys(parsedQuery);

  console.log(expectedQuery);
  console.log(parsedQuery);

  // 3.1 Check that all query parameters have the expected values
  expectedKeys.forEach((key) => {
    const expectedVal = expectedQuery[key];
    const parsedVal = parsedQuery[key];
    const errPrefix = `Expected query param "${key}" to`;

    if (parsedVal === 'RANDOM_NOT_EMPTY') {
      throw new Error(`${errPrefix} be random, but got "RANDOM_NOT_EMPTY"`);
    }

    if (expectedVal === parsedVal) {
      return;
    }

    if (expectedVal !== 'RANDOM_NOT_EMPTY') {
      throw new Error(`${errPrefix} equal "${expectedVal}", but got "${parsedVal}"`);
    }

    if (!parsedVal || parsedVal.trim() === '') {
      throw new Error(`${errPrefix} be random, but got an empty value`);
    }
  });

  // 3.3 Validate that the query parameters are in the "correct" order. Note,
  //     this is a temporary measure until we support any order in the real
  //     mock-okta server
//   if (expectedKeys.toString() !== parsedKeys.toString()) {
//     const msg = `
// Expected query params to be sent in this order:
// ${expectedKeys}

// Note: For now, send the query params in this order - a future update to the
// mock-okta server will fix this limitation.
//     `;
//     throw new Error(msg);
//   }

  return expected;
}

function handleNextRequest(req, res) {
  let body;
  try {
    const nextRequest = nextMatchingRequest(req);
    validateReq(nextRequest.req, req);
    body = nextRequest.res;
  } catch (e) {
    console.log('got an error');
    console.log(e.message);
    res.statusCode = 500;
    body = {
      error: 'Expectation not met',
      error_description: e.message,
    };
  }
  sendResponse(req, res, body);
}

function fooHandler(req, res) {
  switch (req.url) {
    case '/mock/clear':
      return handleClearRequest(req, res);
    case '/mock/set':
      return handleSetRequest(req, res);
    case '/mock/done':
      return handleDoneRequest(req, res);
    case '/mock/log':
      return handleLogRequest(res);
    case '/.well-known/openid-configuration':
      return handleWellKnownRequest(req, res);
    case '/oauth2/v1/keys':
      return handleKeysRequest(req, res);
   default:
      return handleNextRequest(req, res);
  }
};

const app = connect();

// Handle post parameters
// I ACTUALLY NEED TO DO THIS IN TEST-MOCK-OKTA, which means:
// - Switch it over to using connect
// - Then use bodyParser!
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));

app.use(fooHandler);

http.createServer(app).listen(config.mockOkta.port, () => {
  console.log(`Test server listening on port ${config.mockOkta.port}`);
});

// const server = http.createServer((req, res) => {
//   switch (req.url) {
//     case '/mock/set':
//       return handleSetRequest(req, res);
//     case '/mock/done':
//       return handleDoneRequest(req, res);
//     case '/mock/log':
//       return handleLogRequest(res);
//     case '/.well-known/openid-configuration':
//       return handleWellKnownRequest(req, res);
//     case '/oauth2/v1/keys':
//       return handleKeysRequest(req, res);
//    default:
//       return handleNextRequest(req, res);
//   }
// });

// server.listen(config.mockOkta.port, () => {
//   console.log(`Test server listening on port ${config.mockOkta.port}`);
// });
