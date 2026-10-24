import {GET as get,POST as post} from "./[...path]/route";
export const dynamic="force-dynamic";
export const GET=(request:Request)=>get(request,{params:Promise.resolve({path:[]})});
export const POST=(request:Request)=>post(request,{params:Promise.resolve({path:[]})});
