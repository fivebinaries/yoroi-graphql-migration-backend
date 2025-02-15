import { Pool } from "pg";
import { Request, Response } from "express";

import config from "config";
import {
  assertNever,
  validateAddressesReq,
  getAddressesByType,
  extractAssets,
} from "../utils";

const utxoForAddressQuery = `
    SELECT *
    FROM valid_utxos_view
    WHERE address = any(($1)::varchar array) 
         OR payment_cred = any(($2)::bytea array);
`;

const addressesRequestLimit: number = config.get("server.addressRequestLimit");

export const utxoForAddresses =
  (pool: Pool) => async (req: Request, res: Response) => {
    if (!req.body || !req.body.addresses) {
      throw new Error("error, no addresses.");
      return;
    }
    const addressTypes = getAddressesByType(req.body.addresses);
    const verifiedAddresses = validateAddressesReq(
      addressesRequestLimit,
      req.body.addresses
    );
    switch (verifiedAddresses.kind) {
      case "ok": {
        const result = await pool.query(utxoForAddressQuery, [
          [...addressTypes.legacyAddr, ...addressTypes.bech32],
          addressTypes.paymentCreds,
        ]);
        const utxos = result.rows.map((utxo) => ({
          utxo_id: `${utxo.hash}:${utxo.index}`,
          tx_hash: utxo.hash,
          tx_index: utxo.index,
          receiver: utxo.address,
          amount: utxo.value.toString(),
          assets: extractAssets(utxo.assets),
          block_num: utxo.blockNumber,
        }));
        res.send(utxos);
        return;
      }
      case "error":
        throw new Error(verifiedAddresses.errMsg);
        return;
      default:
        return assertNever(verifiedAddresses);
    }
  };
