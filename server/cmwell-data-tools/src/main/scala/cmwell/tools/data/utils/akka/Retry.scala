/**
  * © 2019 Refinitiv. All Rights Reserved.
  *
  * Licensed under the Apache License, Version 2.0 (the “License”); you may not use this file except in compliance with the License.
  * You may obtain a copy of the License at
  *
  *   http://www.apache.org/licenses/LICENSE-2.0
  *
  * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
  * an “AS IS” BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  *
  * See the License for the specific language governing permissions and
  * limitations under the License.
  */
package cmwell.tools.data.utils.akka

import akka.actor.ActorSystem
import akka.http.scaladsl.Http
import akka.http.scaladsl.model.HttpEntity.{Chunked, LastChunk}
import akka.http.scaladsl.model.StatusCodes.{ClientError, ServerError}
import akka.http.scaladsl.model._
import akka.pattern._
import akka.stream._
import akka.stream.scaladsl._
import akka.util.ByteString
import cmwell.tools.data.utils.ArgsManipulations
import cmwell.tools.data.utils.ArgsManipulations.HttpAddress
import cmwell.tools.data.utils.akka.HeaderOps._
import cmwell.tools.data.utils.logging.{DataToolsLogging, LabelId}

import scala.collection.immutable
import scala.concurrent.duration._
import scala.concurrent.{ExecutionContext, Future}
import scala.language.implicitConversions
import scala.reflect.runtime.universe._
import scala.util.{Failure, Success, Try}
//Used for dataTools cross compilation
import scala.collection.compat._


object Retry extends DataToolsLogging with DataToolsConfig {

  def createNewHostConnectionPool[T](hostName: String)
                                    (implicit system: ActorSystem, mat: Materializer, ec: ExecutionContext) = {
    val HttpAddress(protocol, host, port, _) = ArgsManipulations.extractBaseUrl(hostName)
    HttpConnections.newHostConnectionPool[State[T]](host, port, protocol)
  }

  case class State[T](data: Seq[ByteString],
                   vars: Map[String,String] = Map(),
                   context: Option[T] = None,
                   response: Option[HttpResponse] = None,
                   count: Option[Int] = None,
                   delay: FiniteDuration = 10.seconds){

    def stringifyData(data: Seq[ByteString]) =
      concatByteStrings(data, ByteString(",")).utf8String

    override def toString: String = s"data: ${stringifyData(data)} vars: $vars context: $context response: $response count: $count delay: $delay"
  }

  /**
    * Sends HTTP requests containing `Seq[ByteString]` payload data and context of type `T`.
    *
    * When receiving a response with status=[[akka.http.scaladsl.model.StatusCodes.ServerError ServerError]],
    * the request is sent again after the given amount of time.
    *
    * When receiving a response with status=[[akka.http.scaladsl.model.StatusCodes.ClientError ClientError]],
    * the request is split to single ByteString elements and these requests are sent again.
    * If given payload contains only 1 element, the request if not being retried.
    *
    * @param delay delay time between retries of same request
    * @param parallelism number of concurrent requests to be sent
    * @param createRequest function for creating HTTP request from `Seq[ByteString]`
    * @param system actor system
    * @param mat materializer
    * @param ec execution context
    * @tparam T context type, element paired with each request
    * @return flow which sends (and retries) HTTP requests and returns Try of results paired with request data and context
    */
  def retryHttp[T,S : TypeTag](delay: FiniteDuration,
                   parallelism: Int,
                   limit: Option[Int] = None,
                   delayFactor : Double = 1,
                   managedConnection: Option[Flow[(HttpRequest,State[T]), (Try[HttpResponse],State[T]), Http.HostConnectionPool]] = None)(
                   createRequest: (Seq[ByteString], Map[String,String], Option[T]) => HttpRequest,
                   responseValidator: (ByteString, Seq[HttpHeader]) => Try[Unit] = (_, _) => Success(()))(
                   implicit system: ActorSystem,
                   mat: Materializer,
                   ec: ExecutionContext,
                   label: Option[LabelId] = None) = {

    implicit def asFiniteDuration(d: Duration) = scala.concurrent.duration.Duration.fromNanos(d.toNanos);

    val labelValue = label.map { case LabelId(id) => s"[$id]" }.getOrElse("")
    val toStrictTimeout = 30.seconds

    def headerString(header: HttpHeader): String = header.name + ":" + header.value

    def headersString(headers: Seq[HttpHeader]): String = headers.map(headerString).mkString("[", ",", "]")

    def delayWithFactor(delayFactor: Double, countRemaining: Int, initialDelay: FiniteDuration, retryLimit : Int)  = {
      val isFirstIteration = countRemaining==retryLimit
      if ((delayFactor > 0) && !isFirstIteration) delay * delayFactor else delay
    }

    /*
    case class State(data: Seq[ByteString],
                     vars: Map[String,String] = Map(),
                     context: Option[T] = None,
                     response: Option[HttpResponse] = None,
                     count: Option[Int] = limit,
                     delay: FiniteDuration = delay)*/

    def stringifyData(data: Seq[ByteString]) =
      concatByteStrings(data, ByteString(",")).utf8String

    def retryWith(
      state: State[T]
    ): Option[immutable.Iterable[(Future[Seq[ByteString]], State[T])]] =
      state match {
        case State(data, _, _, Some(HttpResponse(s, h, e, _)), _, _)
            if s == StatusCodes.TooManyRequests =>
          // api garden quota error
          e.toStrict(toStrictTimeout)
            .map { strictEntity =>
              logger.error(
                s"$labelValue retry data: api garden mis-configured, call Yaniv to increase! host=${getHostname(
                  h
                )} status=$s entity=${strictEntity.data.utf8String} data=${concatByteStrings(data, endl).utf8String}"
              )
            }.onComplete{
            case Failure(exception) => logger.error(
              s"$labelValue api garden mis-configured, call Yaniv to increase! host=${getHostname(h)} status=$s cannot read entity", exception
            )
            case Success(_) =>
          }

          // schedule a retry to http stream
          val future = after(delay, system.scheduler)(Future.successful(data))
          Some(immutable.Seq(future -> state))

        case State(data, vars, context, Some(res@HttpResponse(s: ServerError, h, e, _)), count, iterationDelay) =>

          val errorID = res.##

          if (data.size > 1) {
              // before retry a request we should consume previous entity bytes
              e.withoutSizeLimit()
                .dataBytes
                .runFold(blank)(_ ++ _)
                .map { entityBytes =>

                  logger.warn(s"[$errorID] $labelValue server error:  Batch request failed. Will try to send a single request in $delay.\n" +
                    s"host=${
                      getHostnameValue(
                        h
                      )
                    } status=$s, headers: ${headersString(h)}, Body of response:${entityBytes.utf8String}, request data=${stringifyData(data)}"
                  )
                  redLogger.error(
                    s"$labelValue server error: host=${getHostnameValue(h)} status=$s data=${stringifyData(data)} entity=${entityBytes.utf8String}"
                  )
                  badDataLogger.info(
                    s"$labelValue data=${concatByteStrings(data, endl).utf8String}"
                  )
                }
            // failed to send a chunk of data, split to singles and retry
            Some(
              data
                .map(
                  dataElement =>
                    Future.successful(Seq(dataElement)) -> State[T](
                      Seq(dataElement),
                      vars,
                      context,
                      count = limit
                    )
                )
                .to(immutable.Iterable)
            )

          }
          else {
            // server error
            // special case: sparql-processor //todo: remove this in future

            e.dataBytes.runFold(ByteString.empty)(_ ++ _).map(_.utf8String).map{ entity=>
              logger.warn(s"[$errorID] server error. Body of response: $entity, headers: ${headersString(h)}")
            }

            if (e.toString contains "Fetching") {
              logger.warn(
                s"$labelValue will not schedule a retry on data ${concatByteStrings(data, endl).utf8String}"
              )

              None
            } else {
              count match {
                case Some(c) if c > 0 =>

                  val retryBackoff = delayWithFactor(delayFactor,c,iterationDelay,limit.getOrElse(3))

                  logger.debug(
                    s"$labelValue server error - received $s, count=$count will retry again in $retryBackoff" +
                      s" host=${getHostnameValue(h)}"
                  )

                  val future =
                    after(retryBackoff, system.scheduler)(Future.successful(data))
                  Some(immutable.Seq(future -> state.copy(count = Some(c - 1), delay=retryBackoff)))
                case Some(0) =>
                  logger.warn(
                    s"$labelValue server error - received $s, count=$count will not not retry sending request," +
                      s" host=${getHostnameValue(h)}"
                  )
                  badDataLogger.info(
                    s"$labelValue data=${concatByteStrings(data, endl).utf8String}"
                  )
                  None
                case None =>

                  logger.warn(
                    s"$labelValue server error - received $s. host=${getHostnameValue(h)} data=${stringifyData(data)}. Will try again until success " +
                      s"(count is not set) in ${delay}"
                  )

                  val future = after(delay, system.scheduler)(Future.successful(data))
                  Some(immutable.Seq(future -> state.copy(count = limit)))
              }
            }
          }

        case State(
            data,
            vars,
            context,
            Some(HttpResponse(s: ClientError, h, e, _)),
            _, _
            ) =>
          // client error
          if (data.size > 1) {
            // before retry a request we should consume previous entity bytes
            e.withoutSizeLimit()
              .dataBytes
              .runFold(blank)(_ ++ _)
              .map { entityBytes =>
                logger.warn(
                  s"$labelValue client error: will retry again in $delay to send a single request, host=${getHostnameValue(
                    h
                  )} status=$s, entity=${entityBytes.utf8String}, request data=${stringifyData(data)}"
                )
                redLogger.error(
                  s"$labelValue client error: host=${getHostnameValue(h)} status=$s data=${stringifyData(data)} entity=${entityBytes.utf8String}"
                )
                badDataLogger.info(
                  s"$labelValue data=${concatByteStrings(data, endl).utf8String}"
                )
              }

            // failed to send a chunk of data, split to singles and retry
            Some(
              data
                .map(
                  dataElement =>
                    Future.successful(Seq(dataElement)) -> State(
                      Seq(dataElement),
                      vars,
                      context
                  )
                )
                .to(immutable.Iterable)
            )
          } else {
            e.toStrict(toStrictTimeout)
              .map { strictEntity =>
                logger.warn(
                  s"$labelValue client error: will not retry sending request, host=${getHostnameValue(
                    h
                  )} status=$s, entity=${strictEntity.data.utf8String}"
                )
                badDataLogger.info(
                  s"$labelValue data=${concatByteStrings(data, endl).utf8String}"
                )
              }.onComplete{
              case Failure(err) => logger.warn(s"$labelValue client error: will retry again in $delay to send a single request, " +
                s"host=${getHostnameValue(h)} status=$s, cannot read entity, request data=${stringifyData(data)}", err)
              case Success(_) =>
            }

            None // failed to send a single data element
          }

        case State(data, _, _, Some(HttpResponse(s, h, e, _)), count, _) =>

          redLogger.error(
            s"$labelValue error: host=${getHostnameValue(h)} status=$s entity=$e data=${stringifyData(data)}"
          )

          s.isSuccess match {
            case true =>
              // 200 OK, but errors response validator returned false
              logger.warn(s"$labelValue received $s but response body is not valid. " +
                s"host=${getHostnameValue(h)} data=${stringifyData(data)}")
            case _ => e.discardBytes()
              logger.warn(s"$labelValue error: host=${getHostnameValue(h)}" +
                s" status=$s data=${stringifyData(data)}")
          }

          count match {
            case Some(c) if c > 0 =>
              logger.debug(
                s"$labelValue received $s, count=$count will retry again in $delay host=${getHostnameValue(h)}"
              )
              val future =
                after(delay, system.scheduler)(Future.successful(data))
              Some(immutable.Seq(future -> state.copy(count = Some(c - 1))))
            case Some(0) =>
              logger.warn(
                s"$labelValue received $s, count=$count will not not retry sending request, host=${getHostnameValue(h)}"
              )
              badDataLogger.info(
                s"$labelValue data=${concatByteStrings(data, endl).utf8String}"
              )
              None
            case None =>
              logger.warn(
                s"$labelValue received $s, will retry again in $delay host=${getHostnameValue(h)} data=${stringifyData(data)}"
              )
              val future =
                after(delay, system.scheduler)(Future.successful(data))
              Some(immutable.Seq(future -> state))
          }

        case State(data, vars, context, None, count, _) =>
          count match {
            case Some(c) if c > 0 =>
              if(state.data.size > 1) {

                logger.warn(
                  s"$labelValue error: could not send http request with multiple data. Splitting data to individual requests. data=${stringifyData(data)}"
                )

                // Failed to send a chunk of data, split to singles and retry

                Some(
                  data
                    .map(
                      dataElement =>
                        Future.successful(Seq(dataElement)) -> State(
                          Seq(dataElement),
                          vars,
                          context
                        )
                    )
                    .to(immutable.Iterable)
                )
              }

              else{

                logger.warn(
                  s"$labelValue error: could not send http request, counter=$c will retry again in $delay data=${stringifyData(data)}"
                )

                val future = after(delay, system.scheduler)(Future.successful(data))
                Some(immutable.Seq(future -> state.copy(count = Some(c - 1))))
              }
            case Some(0) =>
              logger.warn(
                s"$labelValue error: could not send http request, counter=0, will not retry sending request, data=${stringifyData(data)}"
              )
              badDataLogger.info(
                s"$labelValue data=${concatByteStrings(data, endl).utf8String}"
              )
              None
            case None =>
              logger.warn(
                s"$labelValue error: could not send http request, will retry again in $delay data=${stringifyData(data)}. Going to retry with state: $state"
              )
              val future =
                after(delay, system.scheduler)(Future.successful(data))
              Some(immutable.Seq(future -> state))
          }
        case x =>
          logger.error(s"$labelValue unexpected message: $x")
          None
      }

    val conn = managedConnection match {
      case Some(connection) => connection
      case _ => Http().superPool[State[T]](settings = AkkaUtils.generateConnectionPoolSettings())
    }

    val maxConnections =
      config.getInt("akka.http.host-connection-pool.max-connections")
    val httpPipelineSize =
      config.getInt("akka.http.host-connection-pool.pipelining-limit")
    val httpParallelism = maxConnections * httpPipelineSize

    val job = Flow[(Future[Seq[ByteString]], State[T])]
      .mapAsyncUnordered(httpParallelism) {
        case (data, state) => data.map(_ -> state)
      } // used for delay between executions
      .map { case (data, state) => {
      val req = createRequest(data, state.vars, state.context) -> state
      req
    }

    }
      .via(conn).map {
        case (tryResponse, state) =>
          tryResponse.map(AkkaUtils.decodeResponse) -> state
      }
      .mapAsyncUnordered(httpParallelism) {
        case (response @ Success(HttpResponse(s, _, e, _)), state)
            if !s.isSuccess() =>
          // consume HTTP response bytes
          logger.error(s"$labelValue status is not success ($s) $e")
          Future.successful(Failure(new Exception(s"status is not success ($s) $e")) -> state.copy(response = response.toOption))
        case (response @ Success(res @ HttpResponse(s, headers, e, _)), state) =>
          // consume HTTP response bytes and later pack them in fake response
          val responseAndState = (e match {
            case chunkedEntity: Chunked => {
              chunkedEntity.chunks.runFold[(ByteString, Option[Seq[HttpHeader]])]((ByteString.empty, None)) {
                case (accumulatedEntity, chunk: LastChunk) =>
                  (accumulatedEntity._1 ++ chunk.data, Option(chunk.trailer))
                case (accumulatedEntity, chunk) => (accumulatedEntity._1 ++ chunk.data, None)
              }
            }
            case entity: HttpEntity => {
              entity.withoutSizeLimit.dataBytes.runFold(blank)(_ ++ _).map(_ -> None)
            }
          }).map {
            case (entityBytes, trailerHeaders) =>
              val combinedHeaders = trailerHeaders.fold(headers)(headers ++ _)

              responseValidator(entityBytes, combinedHeaders) match {
                case Success(_) =>
                  Success(res.copy(entity = entityBytes, headers = combinedHeaders)) -> state.copy(
                    response = response.toOption
                  )
                case Failure(err) =>
                  logger.error(s"responseValidator function failed: ${err.getMessage}")
                  Failure(err) -> state.copy(response = response.toOption)
              }
          }

          responseAndState.recover {
            case err =>
              logger.error(
                s"$labelValue error in consuming data bytes from response, paths=${stringifyData(state.data)}, err=$err",
                err  //MORIA Code review - add e.discardBytes() ?
              )
              Failure(err) -> state.copy(response = response.toOption)
          }

        case (res @ Failure(err), state) =>
          logger.error(s"$labelValue received failure", err);
          Future.successful(res -> state)

        case (x, state) =>
          logger.error(s"$labelValue unexpected message: $x")
          Future.successful(
            Failure(new Exception("unexpected message")) -> state
          )
      }

    Flow[(S, Option[T])]
      .map {
        case (data : Seq[ByteString], context) =>
          Future.successful(data) -> State(data = data, context = context, vars=Map())
        case ( (data : Seq[ByteString], vars : Map[String,String]), context) =>
          Future.successful(data) -> State(data = data, context = context, vars=vars)
        case e => logger.error(s"Unexpected state. got: $e"); ???
      }
      .via(GoodRetry.concat(Long.MaxValue, job)(retryWith))
      .map { case (result, state) => (result, state.data, state.context) }
  }
}
