// Deliberately serves only the three prototype assets, on loopback.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const assets={'/':['index.html','text/html'],'/prototype.js':['prototype.js','text/javascript'],'/prototype.css':['prototype.css','text/css']};
const port=Number(process.env.PORT??4388);
createServer(async(req,res)=>{const asset=assets[new URL(req.url,'http://localhost').pathname];if(!asset){res.writeHead(404).end();return}try{res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-store'});res.end(await readFile(new URL(asset[0],import.meta.url)))}catch{res.writeHead(500).end()}}).listen(port,'127.0.0.1',()=>console.log(`Research prototype: http://127.0.0.1:${port}`));
