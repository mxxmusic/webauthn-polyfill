/*
Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License"); you may not use these files except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
*/

/*
This file implements a polyfill that maps current Web Authentication API on
top of the Microsoft Edge preliminary implementation.
It is available for Edge 14 and above.

The polyfill is up-to-date with the 5th working draft of the Web Authentication API 
specification. Please refer to this link for the spec: http://www.w3.org/TR/2017/WD-webauthn-20170505/

This implementation inherits its limitations on parameter values from the
Edge implementation.

Notes on limitations:
The polyfill only works if the user has created a PIN (and optionally Hello
gestures) for themselves in Settings->Accounts->Sign-in options. Otherwise,
a error will be thrown.

create:
	- Few parameters are ignored: attestationChallenge, timeOutSeconds, rpId, excludeList, and authenticatorSelection.
	- the returned signature is different between the current Web Authentication API
	  and the polyfill

get:
 	- Few parameters are ignored: parameters, timeoutSeconds and rpId.
 	- the returned signature is different between the current Web Authentication API
    and the polyfill
*/

/* global msCredentials */
navigator.credentials = navigator.credentials || (function () {
	'use strict';

	const webauthnDB = (function () {
		const WEBAUTHN_DB_VERSION = 1;
		const WEBAUTHN_DB_NAME = '_webauthn';
		const WEBAUTHN_ID_TABLE = 'identities';

		let db = null;
		let initPromise = null;

		const initDB = function () {
	 /* to remove database, use window.indexedDB.deleteDatabase('_webauthn'); */
			return new Promise((resolve, reject) => {
				const req = indexedDB.open(WEBAUTHN_DB_NAME, WEBAUTHN_DB_VERSION);
				req.onupgradeneeded = function() {
					// new database - set up store
					db = req.result;
					db.createObjectStore(WEBAUTHN_ID_TABLE, { keyPath: 'id'});
				};

				req.onsuccess = function() {
					db = req.result;
					resolve();
				};

				req.onerror = function(e) {
					reject(e);
				};
			});
		};

		const doStore = function (id, data) {
			if (!db) {
				throw new Error('UnknownError');
			}
			return new Promise((resolve, reject) => {
				const tx = db.transaction(WEBAUTHN_ID_TABLE, 'readwrite');
				const store = tx.objectStore(WEBAUTHN_ID_TABLE);
				store.put({id, data});

				tx.oncomplete = function() {
					resolve();
				};

				tx.onerror = function(e) {
					reject(e);
				};
			});
		};

		const store = function (id, data) {
			if (!initPromise) {
				initPromise = initDB();
			}
			return initPromise.then(() => {
				return doStore(id, data);
			});
		};

		const doGetAll = function () {
			if (!db) {
				throw new Error('UnknownError');
			}

			return new Promise((resolve, reject) => {
				const tx = db.transaction(WEBAUTHN_ID_TABLE, 'readonly');
				const req = tx.objectStore(WEBAUTHN_ID_TABLE).openCursor();
				const res = [];

				req.onsuccess = function() {
					const cur = req.result;
					if (cur) {
						res.push({id: cur.value.id, data: cur.value.data});
						cur.continue();
					} else {
						resolve(res);
					}
				};

				req.onerror = function(e) {
					reject(e);
				};
			});
		};

		const getAll = function () {
			if (!initPromise) {
				initPromise = initDB();
			}
			return initPromise.then(doGetAll);
		};


		return {
			store,
			getAll
		};
	}());


	const create = function (createOptions) {
		try {
			/* Need to know the display name of the relying party, the display name
			   of the user, and the user id to create a credential. For every user
			   id, there is one credential stored by the authenticator. */

			const makeCredentialOptions = createOptions.publicKey;
			const acct = {
				rpDisplayName: makeCredentialOptions.rp.name,
				userDisplayName: makeCredentialOptions.user.displayName,
				userId: makeCredentialOptions.user.id
			};

			const encryptParams = [];

			if (makeCredentialOptions.user.name) {
				acct.accountName = makeCredentialOptions.user.name;
			}
			if (makeCredentialOptions.user.icon) {
				acct.accountImageUri = makeCredentialOptions.user.icon;
			}

			for (const param of makeCredentialOptions.parameters) {
				let cryptoAlgorithm = param.algorithm;

				// RS256 is one of the RSASSA crypto algorithms.
				if (param.algorithm === 'RS256') {
					cryptoAlgorithm = 'RSASSA-PKCS1-v1_5';
				}

				let cryptoType = param.type;

				// The type identifier used to be 'FIDO_2_0' instead of 'public-key'
				if (param.type === 'public-key') {
					cryptoType = 'FIDO_2_0';
				}

				encryptParams.push({ type: cryptoType, algorithm: cryptoAlgorithm });
			}

			return msCredentials.makeCredential(acct, encryptParams)
				.then((cred) => {
					if (cred.type === 'FIDO_2_0') {
					// The returned credential should be immutable, aka freezed.
						const result = Object.freeze({
							credential: {type: 'public-key', id: cred.id},
							publicKey: JSON.parse(cred.publicKey),
							attestation: cred.attestation
						});

						return webauthnDB.store(cred.id, acct).then(() => {
							return result;
						});
					}

					return cred;
				})
			.catch((err) => {
				console.log(`create failed: ${err}`);
				throw new Error('NotAllowedError');
			});
		} catch (err) {
			throw new Error('NotAllowedError');
		}
	};


	const getCredList = function (allowlist) {
		/* According to the spec, if allowList is supplied, the credentialList
		   comes from the allowList; otherwise the credentialList is from searching all
		   previously stored valid credentials. */
		if (allowlist) {
			return Promise.resolve(allowlist.map((descriptor) => {
				if (descriptor.type === 'public-key') {
					return { type: 'FIDO_2_0', id: descriptor.id};
				}
				return descriptor;
			}));
		}
		return webauthnDB.getAll()
			.then((list) => {
				return Promise.resolve(list.map((descriptor) => {
					return { type: 'FIDO_2_0', id: descriptor.id};
				}));
			})
		.catch((err) => {
			console.log(`Credential lists cannot be retrieved: ${err}`);
		});
	};


	const get = function (credentialRequests) {

		const publicKeyCredRequest = credentialRequests.publicKey

		if (publicKeyCredRequest) {
			let allowlist;
			try {
				allowlist = publicKeyCredRequest ? publicKeyCredRequest.allowList : void 0;
			} catch (e) {
				throw new Error('NotAllowedError');
			}

			return getCredList(allowlist).then((credList) => {
				const filter = { accept: credList };

				return msCredentials.getAssertion(challenge, filter);
			})
			.then((sig) => {
				if (sig.type === 'FIDO_2_0') {
					return Promise.resolve(Object.freeze({

						rawId: sig.id,
						response: {
							clientDataJSON: sig.signature.clientData,
							authenticatorData: sig.signature.authnrData,
							signature: sig.signature.signature
						}

					}));
				}

				return Promise.resolve(sig);
			})
			.catch((err) => {
				console.log(`getAssertion failed: ${err}`);
				throw new Error('NotAllowedError');
			});

		} else {
			console.log(`The current browser only supports Public Key credential`);
			throw new Error('NotAllowedError');
		}

		
	};


	return {
		create,
		get
	};
}());
