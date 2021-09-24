import { assertNever, validateAddressesReq } from "../utils";
import { createStateQueryClient, createInteractionContext } from "@cardano-ogmios/client";
import config from "config";
import { Pool } from "pg";
import { Request, Response } from "express";
import {StateQueryClient} from "@cardano-ogmios/client/dist/StateQuery/StateQueryClient";
import {DelegationsAndRewardsByAccounts} from "@cardano-ogmios/schema";
import { Query } from "@cardano-ogmios/client/dist/StateQuery";
import { Ogmios } from "@cardano-ogmios/schema";

const addrReqLimit:number = config.get("server.addressRequestLimit");
const ogmiosAddress:string = config.get("server.ogmiosAddress");
const ogmiosPort:number = config.get("server.ogmiosPort");

const accountRewardsQuery = `
  select stake_address.hash_raw as "stakeAddress"
      , sum(coalesce("totalReward".spendable_amount,0) - coalesce("totalWithdrawal".amount,0)) as "remainingAmount"
      , sum(coalesce("totalReward".non_spendable_amount,0)) as "remainingNonSpendableAmount"
      , sum(coalesce("totalReward".spendable_amount,0) + coalesce("totalReward".non_spendable_amount,0)) as "reward"
      , sum(coalesce("totalWithdrawal".amount, 0)) as "withdrawal"

  from stake_address

  left outer join (
    SELECT addr_id, sum(amount) as "amount"
    FROM withdrawal
    join stake_address withdrawal_stake_address
    on withdrawal_stake_address.id = withdrawal.addr_id
    where encode(withdrawal_stake_address.hash_raw, 'hex') = any(($1)::varchar array)
    GROUP BY
      addr_id
  ) as "totalWithdrawal" on stake_address.id = "totalWithdrawal".addr_id

  left outer join (
    SELECT addr_id,
      sum(case when "current_epoch".value >= spendable_epoch then amount else 0 end) as "spendable_amount",
      sum(case when "current_epoch".value < spendable_epoch then amount else 0 end) as "non_spendable_amount"
    FROM reward
    join stake_address reward_stake_address
    on reward_stake_address.id = reward.addr_id
    cross join (select max (epoch_no) as value from block) as "current_epoch"
    where encode(reward_stake_address.hash_raw, 'hex') = any(($1)::varchar array)
    GROUP BY
      addr_id
  ) as "totalReward" on stake_address.id = "totalReward".addr_id

  where encode(stake_address.hash_raw, 'hex') = any(($1)::varchar array)

  group by stake_address.id`;

interface RewardInfo {
  remainingAmount: string;
  remainingNonSpendableAmount: string;
  rewards: string;
  withdrawals: string;
  poolOperator: null;
  isRewardsOff?: boolean;
}

interface Dictionary<T> {
    [key: string]: T;
}

type OgmiosRes = { [k: string]: number };
type OgmiosErr = { err: string };
type OgmiosReturn = OgmiosRes | OgmiosErr;

const OGMIOS_CLIENT: StateQueryClient[] = [];

const getRewardStateFromOgmios = async (addresses: string[]): Promise<OgmiosReturn> => {
  try {
    const ogmiosAddressFixArr = addresses.map(x => x.substring(2));
    if (!OGMIOS_CLIENT[0]) {
      const context = await createInteractionContext(
        console.error,
        () => console.log("closed."),
        {connection: {host: ogmiosAddress, port: ogmiosPort}}
      );
      OGMIOS_CLIENT[0] = await createStateQueryClient(context);
    }
    const result = await OGMIOS_CLIENT[0].delegationsAndRewards(ogmiosAddressFixArr);
    return Object.entries(result).reduce((res: { [k: string]: number }, [hash, rew]) => {
      if (rew.rewards != null) {
        res["e1" + hash] = rew.rewards;
      }
      return res;
    }, {});
  } catch (e) {
    console.error("Failed to getRewardStateFromOgmios!", e);
    return { err: String(e) };
  }
};

const getRewardStateFromOgmios2 = async (addresses: string[]): Promise<any> => {
  try {
    const ogmiosAddressFixArr = addresses.map(x => x.substring(2));
    const context = await createInteractionContext(
      console.error,
      () => console.log("closed."),
      {connection: {host: ogmiosAddress, port: ogmiosPort}}
    );
    return await Query<
      Ogmios["Query"],
      Ogmios["QueryResponse[delegationsAndRewards]"],
      any
      >({
      methodName: "Query",
      args: {
        query: { delegationsAndRewards: ogmiosAddressFixArr }
      }
    }, {
      handler: (response, resolve) => {
        resolve(response.result);
      }
    }, context);
  } catch (e) {
    console.error("Failed to getRewardStateFromOgmios2!", e);
    return { err: String(e) };
  }
};

const getAccountStateFromDB = async (pool: Pool, addresses: string[]): Promise<Dictionary<RewardInfo|null>> => {
  const ret : Dictionary<RewardInfo|null> = {};
  const rewards = await pool.query(accountRewardsQuery, [addresses]);
  for(const row of rewards.rows) {
    ret[row.stakeAddress.toString("hex")] = {
      remainingAmount: row.remainingAmount
      , remainingNonSpendableAmount: row.remainingNonSpendableAmount
      , rewards: row.reward
      , withdrawals: row.withdrawal
      , poolOperator: null //not implemented
      , isRewardsOff: true
    };
  }
  for( const addr of addresses)
    if (!(addr in ret))
      ret[addr] = null;
  return ret;
};

const askAccountRewards = async (pool: Pool, addresses: string[]): Promise<Dictionary<RewardInfo|null>> => {
  const ogmiosPromise = getRewardStateFromOgmios(addresses)
    .catch(e => ({ err: String(e) }));
  const ogmiosPromise2 = getRewardStateFromOgmios2(addresses)
    .catch(e => ({ err: String(e) }));
  const dbPromise = getAccountStateFromDB(pool, addresses);

  const [ogmiosResult, ogmiosResult2, dbResult]: [OgmiosReturn, any, Dictionary<RewardInfo|null>]
    = await Promise.all([ogmiosPromise, ogmiosPromise2, dbPromise]);

  console.log("ogmiosResult:", ogmiosResult);
  console.log("ogmiosResult2:", ogmiosResult2);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  dbResult["ogmios"] = ogmiosResult;
  dbResult["ogmios2"] = ogmiosResult2;

  if (ogmiosResult.err == null) {
    for (const a of addresses) {
      const dbResultElement = dbResult[a];
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const ogResultNumber = ogmiosResult[a];
      if (dbResultElement != null && ogResultNumber != null) {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        dbResultElement.remainingAmountDB = dbResultElement.remainingAmount;
        dbResultElement.remainingAmount = String(ogResultNumber);
      }
    }
  }

  return dbResult;
};

export const handleGetAccountState = (pool: Pool) => async (req: Request, res:Response): Promise<void> => {
  if(!req.body || !req.body.addresses) {
    throw new Error("no addresses.");
    return;
  } 
  const verifiedAddrs = validateAddressesReq(addrReqLimit, req.body.addresses);
  switch(verifiedAddrs.kind){
  case "ok": {
    const accountState = await askAccountRewards(pool, verifiedAddrs.value);
    res.send(accountState); 
    return;
  }
  case "error":
    throw new Error(verifiedAddrs.errMsg);
    return;
  default: return assertNever(verifiedAddrs);
  }
};
