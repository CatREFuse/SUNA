import {parseDshPluginManagement} from '../src/runtime/dsh-plugin-management-contract.mjs';
import {safeDshManagementError} from '../plugins/suna-dsh/plugin-management-errors.mjs';

export const DSH_MANAGEMENT_ROUTE = '/plugins/suna-dsh-plugins/ui/rpc';
const denied = error => ({ok: false, error: safeDshManagementError(error)});

/** Main owns native headers. An iframe receives neither IPC access nor a generic authenticated HTTP proxy. */
export function createDshPluginManagementHandler({applicationFrame, api}) {
  return async (event, input) => {
    try { applicationFrame(event); }
    catch { return denied({code: 'DSH_PLUGIN_NATIVE_REQUIRED'}); }
    let request;
    try { request = parseDshPluginManagement(input); }
    catch (error) { return denied(error); }
    try {
      const result = await api(DSH_MANAGEMENT_ROUTE, request);
      try { applicationFrame(event); }
      catch { return denied({code: 'DSH_PLUGIN_NATIVE_REQUIRED'}); }
      return {ok: true, result};
    } catch (error) { return denied(error); }
  };
}
