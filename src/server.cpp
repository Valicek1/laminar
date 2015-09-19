///
/// Copyright 2015 Oliver Giles
///
/// This file is part of Laminar
///
/// Laminar is free software: you can redistribute it and/or modify
/// it under the terms of the GNU General Public License as published by
/// the Free Software Foundation, either version 3 of the License, or
/// (at your option) any later version.
///
/// Laminar is distributed in the hope that it will be useful,
/// but WITHOUT ANY WARRANTY; without even the implied warranty of
/// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
/// GNU General Public License for more details.
///
/// You should have received a copy of the GNU General Public License
/// along with Laminar.  If not, see <http://www.gnu.org/licenses/>
///
#include "server.h"
#include "interface.h"
#include "laminar.capnp.h"
#include "resources.h"

#include <capnp/ez-rpc.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/rpc.capnp.h>
#include <kj/async-io.h>
#include <kj/debug.h>
#include <kj/threadlocal.h>

#include <websocketpp/config/core.hpp>
#include <websocketpp/server.hpp>

#include <sys/eventfd.h>

// Configuration struct for the websocketpp template library.
struct wsconfig : public websocketpp::config::core {
//    static const websocketpp::log::level elog_level =
//        websocketpp::log::elevel::info;

//    static const websocketpp::log::level alog_level =
//        websocketpp::log::alevel::access_core |
//        websocketpp::log::alevel::message_payload ;

    static const websocketpp::log::level elog_level =
        websocketpp::log::elevel::none;

    static const websocketpp::log::level alog_level =
        websocketpp::log::alevel::none;

    typedef struct { LaminarClient* lc; } connection_base;
};
typedef websocketpp::server<wsconfig> websocket;

namespace {

// Used for returning run state to RPC clients
LaminarCi::JobResult fromRunState(RunState state) {
    switch(state) {
    case RunState::SUCCESS: return LaminarCi::JobResult::SUCCESS;
    default:
        KJ_DBG("TODO log state", to_string(state));
        return LaminarCi::JobResult::UNKNOWN;
    }
}

}

// This is the implementation of the Laminar Cap'n Proto RPC interface.
// As such, it implements the pure virtual interface generated from
// laminar.capnp with calls to the LaminarInterface
class RpcImpl : public LaminarCi::Server {
public:
    RpcImpl(LaminarInterface& l) :
        LaminarCi::Server(),
        laminar(l)
    {
    }

    // Start a job, without waiting for it to finish
    kj::Promise<void> trigger(TriggerContext context) override {
        std::string jobName = context.getParams().getJobName();
        KJ_LOG(INFO, "RPC trigger", jobName);
        ParamMap params;
        for(auto p : context.getParams().getParams()) {
            params[p.getName().cStr()] = p.getValue().cStr();
        }
        LaminarCi::MethodResult result = laminar.queueJob(jobName, params)
                ? LaminarCi::MethodResult::SUCCESS
                : LaminarCi::MethodResult::FAILED;
        context.getResults().setResult(result);
        return kj::READY_NOW;
    }

    // Start a job and wait for the result
    kj::Promise<void> start(StartContext context) override {
        std::string jobName = context.getParams().getJobName();
        KJ_LOG(INFO, "RPC start", jobName);
        ParamMap params;
        for(auto p : context.getParams().getParams()) {
            params[p.getName().cStr()] = p.getValue().cStr();
        }
        std::shared_ptr<Run> run = laminar.queueJob(jobName, params);
        if(run.get()) {
            return laminar.waitForRun(run.get()).then([context](RunState state) mutable {
                context.getResults().setResult(fromRunState(state));
            });
        } else {
            context.getResults().setResult(LaminarCi::JobResult::UNKNOWN);
            return kj::READY_NOW;
        }
    }

    // Wait for an already-running job to complete, returning the result
    kj::Promise<void> pend(PendContext context) override {
        std::string jobName = context.getParams().getJobName();
        int buildNum = context.getParams().getBuildNum();
        KJ_LOG(INFO, "RPC pend", jobName, buildNum);

        kj::Promise<RunState> promise = laminar.waitForRun(jobName, buildNum);

        return promise.then([context](RunState state) mutable {
            context.getResults().setResult(fromRunState(state));
        });
    }

    // Set a parameter on a running build
    kj::Promise<void> set(SetContext context) override {
        std::string jobName = context.getParams().getJobName();
        int buildNum = context.getParams().getBuildNum();
        KJ_LOG(INFO, "RPC set", jobName, buildNum);

        LaminarCi::MethodResult result = laminar.setParam(jobName, buildNum,
            context.getParams().getParam().getName(), context.getParams().getParam().getValue())
                ? LaminarCi::MethodResult::SUCCESS
                : LaminarCi::MethodResult::FAILED;
        context.getResults().setResult(result);
        return kj::READY_NOW;
    }

private:
    LaminarInterface& laminar;
    kj::LowLevelAsyncIoProvider* asyncio;
};


// This is the implementation of the HTTP/Websocket interface. It exposes
// websocket connections as LaminarClients and registers them with the
// LaminarInterface so that status messages will be delivered to the client.
// On opening a websocket connection, it delivers a status snapshot message
// (see LaminarInterface::sendStatus)
class Server::HttpImpl {
public:
    HttpImpl(LaminarInterface& l) :
        laminar(l)
    {
        // debug logging
        // wss.set_access_channels(websocketpp::log::alevel::all);
        // wss.set_error_channels(websocketpp::log::elevel::all);

        // TODO: This could be used in the future to trigger actions on the
        // server in response to a web client request. Currently not supported.
        // wss.set_message_handler([](std::weak_ptr<void> s, websocket::message_ptr msg){
        //     msg->get_payload();
        // });

        // Handle plain HTTP requests by delivering the binary resource
        wss.set_http_handler([this](websocketpp::connection_hdl hdl){
            websocket::connection_ptr c = wss.get_con_from_hdl(hdl);
            const char* start, *end;
            std::string resource = c->get_resource();
            if(resource.compare(0, strlen("/archive/"), "/archive/") == 0) {
                std::string file(resource.substr(strlen("/archive/")));
                std::string content;
                if(laminar.getArtefact(file, content)) {
                    c->set_status(websocketpp::http::status_code::ok);
                    c->set_body(content);
                } else {
                    c->set_status(websocketpp::http::status_code::not_found);
                }
            } else if(resources.handleRequest(resource, &start, &end)) {
                c->set_status(websocketpp::http::status_code::ok);
                c->append_header("Content-Encoding", "gzip");
                c->set_body(std::string(start, end));
            } else {
                // 404
                c->set_status(websocketpp::http::status_code::not_found);
            }
        });

        // Handle new websocket connection. Parse the URL to determine
        // the client's scope of interest, register the client for update
        // messages, and call sendStatus.
        wss.set_open_handler([this](websocketpp::connection_hdl hdl){
            websocket::connection_ptr c = wss.get_con_from_hdl(hdl);
            std::string res = c->get_resource();
            if(res.substr(0, 5) == "/jobs") {
                if(res.length() == 5) {
                    c->lc->scope.type = MonitorScope::ALL;
                } else {
                    res = res.substr(5);
                    int split = res.find('/',1);
                    std::string job = res.substr(1,split-1);
                    if(!job.empty()) {
                        c->lc->scope.job = job;
                        c->lc->scope.type = MonitorScope::JOB;
                    }
                    if(split != std::string::npos) {
                        int split2 = res.find('/', split+1);
                        std::string run = res.substr(split+1, split2-split);
                        if(!run.empty()) {
                            c->lc->scope.num = atoi(run.c_str());
                            c->lc->scope.type = MonitorScope::RUN;
                        }
                        if(split2 != std::string::npos && res.compare(split2, 4, "/log") == 0) {
                            c->lc->scope.type = MonitorScope::LOG;
                        }
                    }
                }
            }
            laminar.registerClient(c->lc);
            laminar.sendStatus(c->lc);
        });

        wss.set_close_handler([this](websocketpp::connection_hdl hdl){
            laminar.deregisterClient(wss.get_con_from_hdl(hdl)->lc);
        });
    }

    // Return a new connection object linked with the context defined below.
    // This is a bit untidy, it would be better to make them a single object,
    // but I didn't yet figure it out
    websocket::connection_ptr newConnection(LaminarClient* lc) {
        websocket::connection_ptr c = wss.get_connection();
        c->lc = lc;
        return c;
    }

private:
    Resources resources;
    LaminarInterface& laminar;
    websocket wss;
};

// Context for an RPC connection
struct RpcConnection {
    RpcConnection(kj::Own<kj::AsyncIoStream>&& stream,
                  capnp::Capability::Client bootstrap,
                  capnp::ReaderOptions readerOpts) :
        stream(kj::mv(stream)),
        network(*this->stream, capnp::rpc::twoparty::Side::SERVER, readerOpts),
        rpcSystem(capnp::makeRpcServer(network, bootstrap))
    {
    }
    kj::Own<kj::AsyncIoStream> stream;
    capnp::TwoPartyVatNetwork network;
    capnp::RpcSystem<capnp::rpc::twoparty::VatId> rpcSystem;
};

// Context for a WebsocketConnection (implements LaminarClient)
// This object is a streambuf and reimplements xsputn so that it can follow any
// write the websocketpp library makes to it with a write to the appropriate
// descriptor in the kj-async context.
struct Server::WebsocketConnection : public LaminarClient, public std::streambuf {
    WebsocketConnection(kj::Own<kj::AsyncIoStream>&& stream, Server::HttpImpl& http) :
        stream(kj::mv(stream)),
        out(this),
        cn(http.newConnection(this)),
        writePaf(kj::newPromiseAndFulfiller<void>())
    {
        cn->register_ostream(&out);
        cn->start();
    }

    ~WebsocketConnection() noexcept(true) {
        outputBuffer.clear();
        writePaf.fulfiller->fulfill();
    }

    kj::Promise<void> pend() {
        return stream->tryRead(ibuf, 1, 1024).then([this](size_t sz){
            cn->read_all(ibuf, sz);
            if(sz == 0 || cn->get_state() == websocketpp::session::state::closed) {
                cn->eof();
                return kj::Promise<void>(kj::READY_NOW);
            }
            return pend();
        });
    }

    kj::Promise<void> writeTask() {
        return writePaf.promise.then([this]() {
            std::string payload;
            // clear the outputBuffer for more context, and take a chunk
            // to send now
            payload.swap(outputBuffer);
            writePaf = kj::newPromiseAndFulfiller<void>();
            if(payload.empty()) {
                return kj::Promise<void>(kj::READY_NOW);
            } else {
                return stream->write(payload.data(), payload.length()).then([this]{
                    return writeTask();
                });
            }
        });
    }

    void sendMessage(std::string payload) override {
        cn->send(payload, websocketpp::frame::opcode::text);
    }

    std::streamsize xsputn(const char* s, std::streamsize sz) override {
        outputBuffer.append(std::string(s, sz));
        writePaf.fulfiller->fulfill();
        return sz;
    }

    kj::Own<kj::AsyncIoStream> stream;
    std::ostream out;
    websocket::connection_ptr cn;
    std::string outputBuffer;
    kj::PromiseFulfillerPair<void> writePaf;
    // TODO: think about this size
    char ibuf[1024];
};

Server::Server(LaminarInterface& li, kj::StringPtr rpcBindAddress,
               kj::StringPtr httpBindAddress) :
    rpcInterface(kj::heap<RpcImpl>(li)),
    httpInterface(new HttpImpl(li)),
    ioContext(kj::setupAsyncIo()),
    tasks(*this)
{

    { // RPC task
        auto paf = kj::newPromiseAndFulfiller<uint>();
        tasks.add(ioContext.provider->getNetwork().parseAddress(rpcBindAddress, 0)
                  .then(kj::mvCapture(paf.fulfiller,
                                      [this](kj::Own<kj::PromiseFulfiller<uint>>&& portFulfiller,
                                      kj::Own<kj::NetworkAddress>&& addr) {
            auto listener = addr->listen();
            portFulfiller->fulfill(listener->getPort());
            acceptRpcClient(kj::mv(listener));
        })));
    }

    { // HTTP task
        auto paf = kj::newPromiseAndFulfiller<uint>();
        tasks.add(ioContext.provider->getNetwork().parseAddress(httpBindAddress, 0)
                  .then(kj::mvCapture(paf.fulfiller,
                                      [this](kj::Own<kj::PromiseFulfiller<uint>>&& portFulfiller,
                                      kj::Own<kj::NetworkAddress>&& addr) {
            auto listener = addr->listen();
            portFulfiller->fulfill(listener->getPort());
            acceptHttpClient(kj::mv(listener));
        })));
    }
}

Server::~Server() {
    // RpcImpl is deleted through Capability::Client.
    // Deal with the HTTP interface the old-fashioned way
    delete httpInterface;
}

void Server::start() {
    // this eventfd is just to allow us to quit the server at some point
    // in the future by adding this event to the async loop. I couldn't see
    // a simpler way...
    efd = eventfd(0,0);
    kj::Promise<void> quit = kj::evalLater([this](){
        static uint64_t _;
        auto wakeEvent = ioContext.lowLevelProvider->wrapInputFd(efd);
        return wakeEvent->read(&_, sizeof(uint64_t)).attach(std::move(wakeEvent));
    });
    quit.wait(ioContext.waitScope);
}

void Server::stop() {
    eventfd_write(efd, 1);
}

void Server::addProcess(int fd, std::function<void(char*,size_t)> readCb, std::function<void()> cb) {
    auto event = this->ioContext.lowLevelProvider->wrapInputFd(fd);
    tasks.add(handleProcessOutput(event,readCb).attach(std::move(event)).then(std::move(cb)));
}

void Server::acceptHttpClient(kj::Own<kj::ConnectionReceiver>&& listener) {
    auto ptr = listener.get();
    tasks.add(ptr->accept().then(kj::mvCapture(kj::mv(listener),
        [this](kj::Own<kj::ConnectionReceiver>&& listener,
                            kj::Own<kj::AsyncIoStream>&& connection) {
            acceptHttpClient(kj::mv(listener));
            auto conn = kj::heap<WebsocketConnection>(kj::mv(connection), *httpInterface);
            return conn->pend().exclusiveJoin(conn->writeTask()).attach(std::move(conn));
        }))
    );
}

void Server::acceptRpcClient(kj::Own<kj::ConnectionReceiver>&& listener) {
    auto ptr = listener.get();
    tasks.add(ptr->accept().then(kj::mvCapture(kj::mv(listener),
        [this](kj::Own<kj::ConnectionReceiver>&& listener,
                            kj::Own<kj::AsyncIoStream>&& connection) {
            acceptRpcClient(kj::mv(listener));
            auto server = kj::heap<RpcConnection>(kj::mv(connection), rpcInterface, capnp::ReaderOptions());
            tasks.add(server->network.onDisconnect().attach(kj::mv(server)));
        }))
    );
}

// handles stdout/stderr from a child process by sending it to the provided
// callback function
kj::Promise<void> Server::handleProcessOutput(kj::AsyncInputStream* stream, std::function<void(char*,size_t)> readCb) {
    // TODO think about this size
    static char* buffer = new char[1024];
    return stream->tryRead(buffer, 1, 1024).then([this,stream,readCb](size_t sz) {
        readCb(buffer, sz);
        if(sz > 0) {
            return handleProcessOutput(stream, readCb);
        }
        return kj::Promise<void>(kj::READY_NOW);
    });
}
