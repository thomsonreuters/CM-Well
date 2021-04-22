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
package controllers

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.Locale

import actions._
import akka.NotUsed
import akka.actor.ActorRef
import akka.pattern.AskTimeoutException
import akka.stream.scaladsl.Source
import akka.util.{ByteString, Timeout}
import cmwell.common.CommandSerializer
import cmwell.common.file.MimeTypeIdentifier
import cmwell.domain.{BagOfInfotons, CompoundInfoton, DeletedInfoton, FString, PaginationInfo, SearchResponse, SearchResults, _}
import cmwell.formats._
import cmwell.fts._
import cmwell.rts.{Pull, Push, Subscriber}
import cmwell.syntaxutils.!!!
import cmwell.util.concurrent.{SimpleScheduler, SingleElementLazyAsyncCache}
import cmwell.util.formats.Encoders
import cmwell.util.http.SimpleHttpClient
import cmwell.util.loading.ScalaJsRuntimeCompiler
import cmwell.util.stream.StreamEventInspector
import cmwell.util.string.Base64
import cmwell.util.{BoxedFailure, EmptyBox, FullBox}
import cmwell.web.ld.cmw.CMWellRDFHelper
import cmwell.web.ld.exceptions.UnsupportedURIException
import cmwell.ws.adt.request.{CMWellRequest, CreateConsumer, Search}
import cmwell.ws.adt.{BulkConsumeState, ConsumeState, SortedConsumeState}
import cmwell.ws.util.RequestHelpers._
import cmwell.ws.util.TypeHelpers._
import cmwell.ws.util._
import cmwell.ws.{Settings, Streams}
import com.google.common.cache.{Cache, CacheBuilder}
import com.typesafe.scalalogging.LazyLogging
import filters.Attrs
import javax.inject._
import k.grid.{ClientActor, Grid, GridJvm, RestartJvm}
import ld.cmw.passiveFieldTypesCacheImpl
import ld.exceptions.BadFieldTypeException
import logic.services.{RedirectionService, ServicesRoutesCache}
import logic.{CRUDServiceFS, InfotonValidator}
import markdown.MarkdownFormatter
import org.joda.time.format.ISODateTimeFormat
import org.joda.time.{DateTime, DateTimeZone}
import play.api.http.{ContentTypes, MediaType}
import play.api.libs.json.{JsArray, JsBoolean, JsNumber, JsObject, JsString, _}
import play.api.mvc.request.RequestTarget
import play.api.mvc.{ResponseHeader, Result, _}
import play.utils.UriEncoding
import security.PermissionLevel.PermissionLevel
import security._
import wsutil.{asyncErrorHandler, errorHandler, _}

import scala.collection.immutable
import scala.collection.mutable.{HashMap, MultiMap}
import scala.concurrent._
import scala.concurrent.duration._
import scala.language.postfixOps
import scala.util.{Failure, Success, Try}
import scala.xml.Utility

object ApplicationUtils {

  /**
    * returns a boolean future determining weather deletion is allowed, and if it's forbidden, also returns a message with the reason.
    *
    * @param path
    * @return
    */
  def infotonPathDeletionAllowed(path: String, recursive: Boolean, crudServiceFS: CRUDServiceFS)(
    implicit ec: ExecutionContext
  ): Future[Either[String, Seq[String]]] = {
    def numOfChildren(p: String): Future[SearchResults] = {
      val pathFilter = if (p.length > 1) Some(PathFilter(p, true)) else None
      crudServiceFS.search(pathFilter,
                           None,
                           Some(DatesFilter(None, None)),
                           PaginationParams(0, 500),
                           false,
                           false,
                           SortParam.empty,
                           false,
                           false)
    }

    if (!InfotonValidator.isInfotonNameValid(path)) Future.successful {
      Left(s"the path $path is not valid for deletion. ")
    } else if (recursive) numOfChildren(path).map {
      case sr if sr.total > 500 =>
        Left("recursive DELETE is forbidden for large (>500 descendants) infotons. DELETE descendants first.")
      case sr => Right(sr.infotons.map(_.systemFields.path) :+ path)
    } else Future.successful(Right(Seq(path)))
  }

  def getNoCacheHeaders(): List[(String, String)] = {
    val d = java.time.LocalDateTime.now().format(ResponseHeader.httpDateFormat)
    List("Expires" -> d, "Date" -> d, "Cache-Control" -> "no-cache, private, no-store", "Pragma" -> "no-cache")
  }
}

@Singleton
class Application @Inject()(bulkScrollHandler: BulkScrollHandler,
                            activeInfotonGenerator: ActiveInfotonGenerator,
                            crudServiceFS: CRUDServiceFS,
                            streams: Streams,
                            authUtils: AuthUtils,
                            cmwellRDFHelper: CMWellRDFHelper,
                            formatterManager: FormatterManager,
                            assetsMetadataProvider: AssetsMetadataProvider,
                            assetsConfigurationProvider: AssetsConfigurationProvider,
                            servicesRoutesCache: ServicesRoutesCache)(implicit ec: ExecutionContext)
    extends FileInfotonCaching(assetsMetadataProvider.get, assetsConfigurationProvider.get)
    with InjectedController
    with LazyLogging {

  import ApplicationUtils._

  lazy val typesCache: passiveFieldTypesCacheImpl = crudServiceFS.passiveFieldTypesCache
  val fullDateFormatter = ISODateTimeFormat.dateTime().withZone(DateTimeZone.UTC)
  val successResponse = Ok(Json.obj("success" -> true))

  def isReactive[A](req: Request[A]): Boolean = req.getQueryString("reactive").fold(false)(!_.equalsIgnoreCase("false"))

  //TODO: validate query params

  private def requestSlashValidator[A](request: Request[A]): Try[Request[A]] = Try {
    if (request.path.toUpperCase(Locale.ENGLISH).contains("%2F"))
      throw new UnsupportedURIException("%2F is illegal in the path part of the URI!")
    else {
      val decodedPath = UriEncoding.decodePath(request.path, "UTF-8")
      val requestHeader = request.withTarget(
        RequestTarget(uriString = decodedPath + request.uri.drop(request.path.length),
          path = decodedPath,
          queryString = request.queryString)
      )
      Request(requestHeader, request.body)
    }
  }

  def handleServicesRoutesCacheGet = Action.async (req => {
    if (req.getQueryString("op").fold(false)(_ == "refresh"))
      servicesRoutesCache.populate().map(_ => Ok("""{"success":true}"""))
    else
      Future.successful(Ok(servicesRoutesCache.list.mkString("\n")))
  })

  def handleTypesCacheGet = Action(_ => Ok(typesCache.getState).as(ContentTypes.JSON))

  val nsCacheTimeout = akka.util.Timeout(1.minute)

  def handleNsCacheGet =
    Action.async(r => {

      def forbiddenOrElse(f: => Future[Result]) =
        if (!isAdminEvenNonProd(r))
          Future.successful(Forbidden(Json.obj("success" -> false, "message" -> "Not authorized")))
        else f

      r.getQueryString("invalidate")
        .fold {
          if (r.getQueryString("invalidate-all").fold(false)(asBoolean(_).getOrElse(true))) forbiddenOrElse {
            cmwellRDFHelper
              .invalidateAll()(nsCacheTimeout)
              .map(_ => successResponse)
              .recover(errorHandler)
          } else {
            val quick = r.getQueryString("quick").fold(false)(asBoolean(_).getOrElse(true))
            cmwellRDFHelper.newestGreatestMetaNsCacheImpl
              .getStatus(quick)(nsCacheTimeout)
              .map(resp => Ok(resp).as(ContentTypes.JSON))
          }
        } { nsID =>
          forbiddenOrElse {
            if (nsID.isEmpty)
              Future.successful(
                BadRequest(Json.obj("success" -> false, "message" -> "You need to specify whom to invalidate"))
              )
            else
              cmwellRDFHelper
                .invalidate(nsID)(nsCacheTimeout)
                .map(_ => successResponse)
                .recover(errorHandler)
          }
        }
    })

  def handleGET(path: String) = Action.async { implicit originalRequest =>
    val op = originalRequest.getQueryString("op").getOrElse("read")
    RequestMonitor.add(op,
      path,
      originalRequest.rawQueryString,
      "",
      originalRequest.attrs(Attrs.RequestReceivedTimestamp))
    requestSlashValidator(originalRequest) match {
      case Failure(e) => asyncErrorHandler(e)
      case Success(request) =>
        request match {
          case Operation.search() => handleSearch(request)
          case Operation.aggregate() => handleAggregate(request)
          case Operation.startScroll() => handleStartScroll(request)
          case Operation.scroll() => handleScroll(request)
          case Operation.createConsumer() => handleCreateConsumerRequest(request)
          case Operation.consume() => handleConsume(request)
          case Operation.subscribe() => handleSubscribe(request)
          case Operation.unsubscribe() => handleUnsubscribe(request)
          case Operation.pull() => handlePull(request)
          case Operation.stream() => handleStream(request)
          case Operation.multiStream() => handleBoostedStream(request)
          case Operation.superStream() => handleSuperStream(request)
          case Operation.queueStream() => handleQueueStream(request)
          case Operation.bulkConsumer() => bulkScrollHandler.handle(request)
          case Operation.fix() => handleFix(request)
          case Operation.info() => handleInfo(request)
          case Operation.verify() => handleVerify(request)
          case Operation.purgeAll() => handlePurgeAll(request)
          case Operation.purgeHistory() => handlePurgeHistory(request)
          case Operation.purgeLast() | Operation.rollback() => handlePurgeLast(request)
          case Operation.read() | _ => handleRead(request)
        }
    }
  }

  def handlePull(req: Request[AnyContent]): Future[Result] = {

    val timeContext = req.attrs.get(Attrs.RequestReceivedTimestamp)

    extractFieldsMask(req, typesCache, cmwellRDFHelper, timeContext).flatMap { fieldsMask =>
      req.getQueryString("sub") match {
        case Some(sub) => {
          val p = Promise[Unit]()
          val source = Source.unfoldAsync[String, ByteString](sub) { subscription =>
            Subscriber
              .pull(subscription)
              .flatMap(
                d =>
                  d.data match {
                    //              //IS FIRST CASE EVEN REACHABLE?!?!?!?
                    //              case _ if p.isCompleted => Future.successful(None)
                    case v if v.isEmpty =>
                      cmwell.util.concurrent.SimpleScheduler.schedule[Option[(String, ByteString)]](3.seconds)(
                        Some(subscription -> cmwell.ws.Streams.endln)
                      )
                    case _ => {
                      val formatter = formatterManager.getFormatter(
                        d.format,
                        timeContext,
                        req.host,
                        req.uri,
                        req.queryString.keySet("pretty"),
                        req.queryString.keySet("raw"),
                        req.queryString.get("callback").flatMap(_.headOption)
                      )

                      val f = crudServiceFS.getInfotonsByPathOrUuid(uuids = d.data).map { bag =>
                        val data = ByteString(
                          bag.infotons.map(i => formatter.render(i.masked(fieldsMask))).mkString("", "\n", "\n"),
                          StandardCharsets.UTF_8
                        )
                        Some(subscription -> data)
                      }
                      //                val f = Future(Some(subscription -> d.data.map(CRUDServiceFS.getInfotonByUuid).collect{
                      //                  case oi : Option[Infoton] if oi.isDefined => oi.get.masked(fieldsMask)
                      //                }.map(formatter.render).mkString("","\n","\n").getBytes("UTF-8")))
                      f.recover {
                        case e => {
                          logger.error("future failed in handlePull", e)
                          Option.empty[(String, ByteString)]
                        }
                      }
                    }
                  }
              )
          }

          Future.successful(Ok.chunked(source))
        }
        case None =>
          Future.successful(BadRequest("missing sub param."))
      }
    }
  }

  /*
    for subscribe

    pull
    http://[host:port]/[path]?op=subscribe&method=pull&qp=?

    push
    http://[host:port]/[path]?op=subscribe&method=push&callback=http://[host]/&qp=?

op=< subscribe | unsubscribe >
format=< json | yaml | n3 | ttl | rdfxml | ... >
method=< push | pull >
bulk-size=< [#infotons] >
subscription-key=< [KEY] >
qp=< [query predicate] >
callback=< [URL] >

   */
  def handleSubscribe(request: Request[AnyContent]): Future[Result] =
    Try {

      val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)
      val path = normalizePath(request.path)
      val name = cmwell.util.os.Props.machineName
      val sub = cmwell.util.string.Hash.crc32(s"$timeContext#$name")
      //    val bulkSize = request.getQueryString("bulk-size").flatMap(asInt).getOrElse(50)
      request
        .getQueryString("qp")
        .map(RTSQueryPredicate.parseRule(_, path))
        .getOrElse(Right(cmwell.rts.PathFilter(new cmwell.rts.Path(path, true)))) match {
        case Left(error) => Future.successful(BadRequest(s"bad syntax for qp: $error"))
        case Right(rule) =>
          request.getQueryString("format").getOrElse("json") match {
            case FormatExtractor(format) =>
              request.getQueryString("method") match {
                case Some(m) if m.equalsIgnoreCase("pull") => Subscriber.subscribe(sub, rule, Pull(format)).map(Ok(_))
                case Some(m) if m.equalsIgnoreCase("push") =>
                  request.getQueryString("callback") match {
                    case Some(url) =>
                      Subscriber.subscribe(sub, rule, Push(getHandlerFor(format, url, timeContext))).map(Ok(_))
                    case None => Future.successful(BadRequest("missing callback for method push"))
                  }
                case _ => Future.successful(BadRequest("unsupported or missing method for real time search "))
              }
            case _ => Future.successful(BadRequest(s"un-recognized type: ${request.headers("format")}"))
          }
      }
    }.recover(asyncErrorHandler).get

  def getHandlerFor(format: FormatType, url: String, timeContext: Option[Long]): (Seq[String]) => Unit = { uuids => {

    uuids.foreach { uuid =>
      logger.debug(s"Sending $uuid to $url.")
    }
    val infotonsFut = crudServiceFS.getInfotonsByPathOrUuid(uuids = uuids.toVector)
    //TODO: probably not the best host to provide a formatter. is there a way to get the original host the subscription was asked from?
    val formatter =
      formatterManager.getFormatter(format, timeContext, s"http://${cmwell.util.os.Props.machineName}:9000")
    val futureRes = infotonsFut.flatMap { bag =>
      import cmwell.util.http.SimpleResponse.Implicits.UTF8StringHandler
      SimpleHttpClient.post[String](url, formatter.render(bag), Some(formatter.mimetype))
    }
    futureRes.onComplete {
      case Success(wsr) =>
        if (wsr.status != 200)
          logger.warn(s"bad response: ${wsr.status}, ${wsr.payload}")
      case Failure(t) => logger.error(s"post to $url failed", t)
    }
  }
  }

  def handleUnsubscribe(request: Request[AnyContent]): Future[Result] = {
    request.getQueryString("sub") match {
      case Some(sub) =>
        Subscriber.unsubscribe(sub)
        Future.successful(Ok(s"unsubscribe $sub"))
      case None =>
        Future.successful(BadRequest("missing sub param. "))
    }
  }

  def handleMetaQuad(base64OfPartition: String) = Action.async { req =>
    val underscorePartition = cmwell.util.string.Base64.decodeBase64String(base64OfPartition, "UTF-8") // e.g: "_2"
  val partition = underscorePartition.tail.toInt
    val iOpt = Some(
      VirtualInfoton(
        ObjectInfoton(SystemFields(
            s"/meta/quad/Y213ZWxsOi8vbWV0YS9zeXMjcGFydGl0aW9u$base64OfPartition",
            new DateTime(DateTimeZone.UTC),
            "VirtualInfoton",
            Settings.dataCenter,
            None,
            "http",
            ""),
          Map[String, Set[FieldValue]]("alias" -> Set(FString(s"partition_$partition")),
            "graph" -> Set(FReference(s"cmwell://meta/sys#partition_$partition"))))
      )
    )
    infotonOptionToReply(req, iOpt.map(VirtualInfoton.v2i))
  }

  def handleProcGET(path: String) = Action.async { implicit req => {
    val iPath: String = {
      val noTrailingSlashes: String = path.dropTrailingChars('/')
      if (noTrailingSlashes == "/proc" || noTrailingSlashes.isEmpty) "/proc" else "/proc/" + noTrailingSlashes
    }
    handleGetForActiveInfoton(req, iPath)
  }
  }

  private def handleGetForActiveInfoton(req: Request[AnyContent], path: String) =
    getQueryString("qp")(req.queryString)
      .fold(Success(None): Try[Option[RawFieldFilter]])(FieldFilterParser.parseQueryParams(_).map(Some.apply))
      .map { qpOpt =>
        // todo: fix this.. should check that the token is valid...
        val tokenOpt = authUtils.extractTokenFrom(req)
        val isRoot = authUtils.isValidatedAs(tokenOpt, "root")
        val length = req
          .getQueryString("length")
          .flatMap(asInt)
          .getOrElse(if (req.getQueryString("format").isEmpty) 13 else 0) // default is 0 unless 1st request for the ajax app
      val offset = req.getQueryString("offset").flatMap(asInt).getOrElse(0)
        val withHistory = req.getQueryString("with-history").flatMap(asBoolean).getOrElse(false)
        val timeContext = req.attrs.get(Attrs.RequestReceivedTimestamp)
        val fieldsFiltersFut = qpOpt.fold[Future[Option[FieldFilter]]](Future.successful(Option.empty[FieldFilter]))(
          rff => RawFieldFilter.eval(rff, typesCache, cmwellRDFHelper, timeContext).map(Some.apply)
        )
        fieldsFiltersFut.flatMap { fieldFilters =>

          val tokenOpt = authUtils.extractTokenFrom(req)
          val isAdmin = authUtils.isOperationAllowedForUser(security.Admin, tokenOpt)

          activeInfotonGenerator
            .generateInfoton(req.host,
              path,
              req.attrs(Attrs.RequestReceivedTimestamp),
              length,
              offset,
              isRoot,
              isAdmin,
              withHistory,
              fieldFilters,
              timeContext)
            .flatMap(iOpt => infotonOptionToReply(req, iOpt.map(VirtualInfoton.v2i)))
        }
      }
      .recover(asyncErrorHandler)
      .get

  def handleZzGET(key: String) = Action.async { implicit req => {
    val allowed = isAdminEvenNonProd(req)

    def mapToResp(task: Future[_]): Future[Result] = {
      val p = Promise[Result]
      task.onComplete {
        case Success(_) => p.success(Ok("""{"success":true}"""))
        case Failure(e) =>
          p.success(Ok(s"""{"success":false,"message":"${Option(e.getMessage).getOrElse(e.getCause.getMessage)}"}"""))
      }
      p.future
    }

    req.getQueryString("op") match {
      case _ if !allowed => Future.successful(Forbidden("Not allowed to use zz"))
      case Some("purge") =>
        mapToResp(crudServiceFS.zStore.remove(key))
      case Some("list") =>
        (req.getQueryString("limit") match {
          case Some(limit) => crudServiceFS.zStore.ls(limit.toInt)
          case None => crudServiceFS.zStore.ls()
        }).map(lsRes => Ok(lsRes.mkString("\n")))
      case Some("put") =>
        val value = req.getQueryString("payload").getOrElse("").getBytes("UTF-8")
        mapToResp(req.getQueryString("ttl") match {
          case Some(ttl) => crudServiceFS.zStore.put(key, value, ttl.toInt, false)
          case None => crudServiceFS.zStore.put(key, value)
        })
      case None =>
        val p = Promise[Result]
        crudServiceFS.zStore.get(key).onComplete {
          case Success(payload) =>
            p.success(
              Ok(
                if (req.getQueryString("format").contains("text")) new String(payload, "UTF-8")
                else payload.mkString(",")
              )
            )
          case Failure(e) =>
            e match {
              case _: NoSuchElementException => p.success(NotFound("zz item not found"))
              case _ =>
                p.success(
                  Ok(s"""{"success":false,"message":"${Option(e.getMessage).getOrElse(e.getCause.getMessage)}"}""")
                )
            }
        }
        p.future
    }
  }
  }

  def handleUuidGET(uuid: String) = Action.async { implicit req => {
    def allowed(infoton: Infoton, level: PermissionLevel = PermissionLevel.Read) =
      authUtils.filterNotAllowedPaths(Seq(infoton.systemFields.path), level, authUtils.extractTokenFrom(req)).isEmpty

    val isPurgeOp = req.getQueryString("op").contains("purge")

    def fields = req.getQueryString("fields").map(FieldNameConverter.toActualFieldNames)

    val timeContext = req.attrs.get(Attrs.RequestReceivedTimestamp)
    if (!uuid.matches("^[a-f0-9]{32}$"))
      Future.successful(BadRequest("not a valid uuid format"))
    else {
      crudServiceFS.getInfotonByUuidAsync(uuid).flatMap {
        case FullBox(infoton) if isPurgeOp && allowed(infoton, PermissionLevel.Write) =>
          val formatter = getFormatter(req, formatterManager, "json")

          req.getQueryString("index") match {
            case Some(index) =>
              crudServiceFS
                .purgeUuidFromIndex(uuid, index)
                .map(
                  _ =>
                    Ok(
                      formatter.render(
                        SimpleResponse(success = true,
                          Some(s"Note: $uuid was only purged from $index but not from CAS!"))
                      )
                    ).as(overrideMimetype(formatter.mimetype, req)._2)
                )
            case None =>
              crudServiceFS.getInfotons(Seq(infoton.systemFields.path)).flatMap { boi =>
                if (infoton.uuid == boi.infotons.head.uuid)
                  Future.successful(
                    BadRequest(
                      "This specific version of CM-Well does not support this operation for the last version of the Infoton."
                    )
                  )
                else {
                  crudServiceFS.purgeUuid(infoton).map { _ =>
                    Ok(formatter.render(SimpleResponse(success = true, None)))
                      .as(overrideMimetype(formatter.mimetype, req)._2)
                  }
                }
              }
          }
        case FullBox(infoton) if isPurgeOp => Future.successful(Forbidden("Not authorized"))

        case FullBox(infoton) if allowed(infoton) =>
          extractFieldsMask(req, typesCache, cmwellRDFHelper, timeContext)
            .flatMap(fm => infotonOptionToReply(req, Some(infoton), fieldsMask = fm))
        case FullBox(infoton) => Future.successful(Forbidden("Not authorized"))

        case EmptyBox => infotonOptionToReply(req, None)
        case BoxedFailure(e) => asyncErrorHandler(e)
      }
    }
  }
  }

  def handleTrack(trackingId: String): Action[AnyContent] = Action.async { implicit request =>
    import cmwell.tracking.{InProgress, TrackingId, TrackingUtil}

    def getDataFromActor(trackingId: String) = trackingId match {
      case TrackingId(tid) => logger.debug(s"Tracking: Trying to get data from $tid"); TrackingUtil().readStatus(tid)
      case _ => Future.failed(new IllegalArgumentException(s"Invalid trackingID"))
    }

    val resultsFut = getDataFromActor(trackingId)
    val formatter = getFormatter(request, formatterManager, defaultFormat = "ntriples", withoutMeta = true)

    def errMsg(msg: String) = s"""{"success":false,"error":"$msg"}"""

    resultsFut
      .map { results =>
        val trackingHeaders =
          if (results.forall(_.status != InProgress)) Seq("X-CM-WELL-TRACKING" -> "Done")
          else Seq.empty[(String, String)]
        val response = BagOfInfotons(results.map(pathStatusAsInfoton))
        Ok(formatter.render(response))
          .withHeaders(trackingHeaders: _*)
          .as(overrideMimetype(formatter.mimetype, request)._2)
      }
      .recover {
        // not using errorHandler in order to hide from user the exception message.
        case _: IllegalArgumentException => BadRequest(errMsg("Invalid trackingID"))
        case _: NoSuchElementException =>
          Gone(errMsg("This tracking ID was never created or its tracked request has been already completed"))
        case _: AskTimeoutException => ServiceUnavailable(errMsg("Tracking is currently unavailable"))
        case _ => InternalServerError(errMsg("An unexpected error has occurred"))
      }
  }

  def handleDELETE(path: String) = Action.async(parse.raw) { implicit originalRequest =>
    requestSlashValidator(originalRequest) match {
      case Failure(e) => asyncErrorHandler(e)
      case Success(request) => {
        val normalizedPath = normalizePath(request.path)
        val modifier = request.attrs(Attrs.UserName)
        val isPriorityWrite = originalRequest.getQueryString("priority").isDefined
        if (!InfotonValidator.isInfotonNameValid(normalizedPath))
          Future.successful(
            BadRequest(
              Json.obj(
                "success" -> false,
                "message" -> """you can't delete from "proc" / "ii" / or any path starting with "_" (service paths...)"""
              )
            )
          )
        else if (isPriorityWrite && !authUtils.isOperationAllowedForUser(security.PriorityWrite,
          authUtils.extractTokenFrom(originalRequest),
          evenForNonProdEnv = true))
          Future.successful(
            Forbidden(Json.obj("success" -> false, "message" -> "User not authorized for priority write"))
          )
        else {
          //deleting values based on json
          request.getQueryString("data") match {
            case Some(jsonStr) =>
              jsonToFields(jsonStr.getBytes("UTF-8")) match {
                case Success(fields) =>
                  crudServiceFS.deleteInfoton(normalizedPath, modifier, Some(fields), isPriorityWrite).map { _ =>
                    Ok(Json.obj("success" -> true))
                  }
                case Failure(exception) => asyncErrorHandler(exception)
              }
            case None => {
              val fields: Option[Map[String, Set[FieldValue]]] = request.getQueryString("field") match {
                case Some(field) =>
                  val value = request.getQueryString("value") match {
                    case Some(value) => FString(value)
                    case _ => FString("*")
                  }
                  Some(Map(field -> Set(value)))
                case _ => None
              }

              val p = Promise[Result]()
              for {
                either <- infotonPathDeletionAllowed(normalizedPath,
                  request.getQueryString("recursive").getOrElse("true").toBoolean,
                  crudServiceFS)
              } {
                (fields.isDefined, either) match {
                  case (true, _) =>
                    crudServiceFS
                      .deleteInfoton(normalizedPath, modifier, fields, isPriorityWrite)
                      .onComplete {
                        case Success(b) => p.success(Ok(Json.obj("success" -> b)))
                        case Failure(e) =>
                          p.success(InternalServerError(Json.obj("success" -> false, "message" -> e.getMessage)))
                      }
                  case (false, Right(paths)) =>
                    crudServiceFS
                      .deleteInfotons(paths.map((_, None)).toList, modifier, isPriorityWrite = isPriorityWrite)
                      .onComplete {
                        case Success(b) => p.success(Ok(Json.obj("success" -> b)))
                        case Failure(e) =>
                          p.success(InternalServerError(Json.obj("success" -> false, "message" -> e.getMessage)))
                      }
                  case (false, Left(msg)) => p.success(BadRequest(Json.obj("success" -> false, "message" -> msg)))
                }
              }
              p.future
            }
          }
        }
      }
    }
  }

  private def handleStartScroll(request: Request[AnyContent]): Future[Result] =
    request
      .getQueryString("qp")
      .fold(Success(None): Try[Option[RawFieldFilter]])(FieldFilterParser.parseQueryParams(_).map(Some.apply))
      .map { qpOpt =>
        val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)
        val normalizedPath = normalizePath(request.path)
        val from = DateParser.parseDate(request.getQueryString("from").getOrElse(""), FromDate).toOption
        val to = DateParser.parseDate(request.getQueryString("to").getOrElse(""), ToDate).toOption
        val length = request.getQueryString("length").flatMap(asInt).getOrElse(500)
        val offset = request.getQueryString("offset").flatMap(asInt).getOrElse(0)
        val scrollTtl = request.getQueryString("session-ttl").flatMap(asInt).getOrElse(15).min(60)
        val withDescendants = request.queryString.keySet("with-descendants") || request.queryString.keySet("recursive")
        val withHistory = request.queryString.keySet("with-history")
        val withDeleted = request.queryString.keySet("with-deleted")
        val pathFilter = Some(PathFilter(normalizedPath, withDescendants))
        val withData = request.getQueryString("with-data")
        val fieldsFiltersFut = qpOpt.fold(Future.successful(Option.empty[FieldFilter]))(
          rff => RawFieldFilter.eval(rff, typesCache, cmwellRDFHelper, timeContext).map(Some.apply)
        )
        fieldsFiltersFut
          .transformWith {
            case Failure(err) => {
              val msg = s"failed to evaluate given qp [${qpOpt.fold("")(_.toString)}]"
              logger.error(msg, err)
              val res = FailedDependency(Json.obj("success" -> false, "message" -> msg))
              request.attrs.get(Attrs.RequestReceivedTimestamp).fold(Future.successful(res)) { reqStartTime =>
                val timePassedInMillis = System.currentTimeMillis() - reqStartTime
                if (timePassedInMillis > 9000L) Future.successful(res)
                else SimpleScheduler.schedule((9500L - timePassedInMillis).millis)(res)
              }
            }
            case Success(fieldFilter) => {
              val formatter = request.getQueryString("format").getOrElse("json") match {
                case FormatExtractor(formatType) =>
                  formatterManager.getFormatter(
                    format = formatType,
                    timeContext = timeContext,
                    host = request.host,
                    uri = request.uri,
                    pretty = request.queryString.keySet("pretty"),
                    callback = request.queryString.get("callback").flatMap(_.headOption),
                    fieldFilters = fieldFilter,
                    offset = Some(offset.toLong),
                    length = Some(length.toLong),
                    withData = withData
                  )
              }

              val fmFut = extractFieldsMask(request, typesCache, cmwellRDFHelper, timeContext)
              val debugInfoParam = request.queryString.keySet("debug-info")
              crudServiceFS
                .thinSearch(
                  pathFilter,
                  fieldFilter,
                  Some(DatesFilter(from, to)),
                  PaginationParams(offset, 1),
                  withHistory,
                  debugInfo = debugInfoParam,
                  withDeleted = withDeleted
                ).map { ftsResults =>
                IterationResults("", ftsResults.total, Some(Vector.empty), debugInfo = ftsResults.debugInfo)
              }.flatMap { thinSearchResult =>
                val withDataB = withData.fold(false)(_.toLowerCase() != "false")
                val rv = createScrollIdDispatcherActorFromIteratorId(StartScrollInput(pathFilter,
                  fieldFilter,
                  Some(DatesFilter(from, to)),
                  PaginationParams(offset, length),
                  scrollTtl,
                  withHistory,
                  withDeleted,
                  withDataB), withHistory, (scrollTtl + 5).seconds)
                fmFut.map { fm =>
                  Ok(formatter.render(thinSearchResult.copy(iteratorId = rv).masked(fm))).as(formatter.mimetype)
                }
              }
            }
          }
          .recover(errorHandler)
      }
      .recover(asyncErrorHandler)
      .get

  private def createScrollIdDispatcherActorFromIteratorId(iterationStateInput: IterationStateInput,
                                                          withHistory: Boolean,
                                                          ttl: FiniteDuration): String = {
    val ar = Grid.createAnon(classOf[IteratorIdDispatcher], iterationStateInput, withHistory, ttl)
    val path = ar.path.toSerializationFormatWithAddress(Grid.me)
    putInCache(path, ar)
    val rv = Base64.encodeBase64URLSafeString(path)
    logger.debug(s"created actor with id = $rv")
    rv
  }

  //TODO: can improve runtime on the expense of generating another temporary collection, i.e:
  /*
   * val m = fromES.collect{case i if i.indexTime.isDefined => i.uuid -> i.indexTime.get}.toMap
   * fromCassandra.map{
   *   case i:<infoton type> => i.copy(indexTime = m.get(i.uuid))
   * }
   */
  private def addIndexTime(fromCassandra: Seq[Infoton], uuidToindexTime: Map[String, Long]): Seq[Infoton] =
  fromCassandra.map {
    case i: ObjectInfoton if i.systemFields.indexTime.isEmpty => i.copy(i.systemFields.copy(indexTime = uuidToindexTime.get(i.uuid)))
    case i: FileInfoton if i.systemFields.indexTime.isEmpty => i.copy(i.systemFields.copy(indexTime = uuidToindexTime.get(i.uuid)))
    case i: LinkInfoton if i.systemFields.indexTime.isEmpty => i.copy(i.systemFields.copy(indexTime = uuidToindexTime.get(i.uuid)))
    case i: DeletedInfoton if i.systemFields.indexTime.isEmpty => i.copy(i.systemFields.copy(indexTime = uuidToindexTime.get(i.uuid)))
    case i => i
  }

  /**
    * answers with a stream, which is basically a chunked response,
    * where each chunk is a reply from a scroll session, and there
    * are multiple scroll sessions (1 per index in ES).
    *
    * @param request
    * @return
    */
  private def handleBoostedStream(request: Request[AnyContent]): Future[Result] =
    request
      .getQueryString("qp")
      .fold(Success(None): Try[Option[RawFieldFilter]])(FieldFilterParser.parseQueryParams(_).map(Some.apply))
      .map { qpOpt =>
        val normalizedPath = normalizePath(request.path)
        val from = DateParser.parseDate(request.getQueryString("from").getOrElse(""), FromDate).toOption
        val to = DateParser.parseDate(request.getQueryString("to").getOrElse(""), ToDate).toOption
        val offset = 0 //request.getQueryString("offset").flatMap(asInt).getOrElse(0)
      val withDescendants = request.queryString.keySet("with-descendants") || request.queryString.keySet("recursive")
        val withHistory = request.queryString.keySet("with-history")
        val withDeleted = request.queryString.keySet("with-deleted")
        val withMeta = request.queryString.keySet("with-meta")
        val length = request.getQueryString("length").flatMap(asLong)
        val pathFilter = Some(PathFilter(normalizedPath, withDescendants))
        val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)
        val fieldsMaskFut = extractFieldsMask(request, typesCache, cmwellRDFHelper, timeContext)
        val (withData, format) = {
          val wd = request.getQueryString("with-data")
          val frmt = request
            .getQueryString("format")
            .getOrElse({
              if (wd.isEmpty) "text" else "nt"
            })
          if (Set("nt", "ntriples", "nq", "nquads").exists(frmt.equalsIgnoreCase) || frmt.toLowerCase.startsWith(
            "json"
          )) {
            Some("text") -> frmt
          } else {
            None -> frmt
          }
        }
        format match {
          case f
            if !Set("text", "path", "tsv", "tab", "nt", "ntriples", "nq", "nquads")(f.toLowerCase) && !f.toLowerCase
              .startsWith("json") =>
            Future.successful(
              BadRequest(
                Json.obj("success" -> false,
                  "message" -> "not a streamable type (use 'text','tsv','ntriples', 'nquads', or any json)")
              )
            )
          case FormatExtractor(formatType) => {
            val fieldsFiltersFut = qpOpt.fold(Future.successful(Option.empty[FieldFilter]))(
              rff => RawFieldFilter.eval(rff, typesCache, cmwellRDFHelper, timeContext).map(Some.apply)
            )
            fieldsFiltersFut
              .transformWith {
                case Failure(err) => {
                  val msg = s"failed to evaluate given qp [${qpOpt.fold("")(_.toString)}]"
                  logger.error(msg, err)
                  val res = FailedDependency(Json.obj("success" -> false, "message" -> msg))
                  request.attrs.get(Attrs.RequestReceivedTimestamp).fold(Future.successful(res)) { reqStartTime =>
                    val timePassedInMillis = System.currentTimeMillis() - reqStartTime
                    if (timePassedInMillis > 9000L) Future.successful(res)
                    else SimpleScheduler.schedule((9500L - timePassedInMillis).millis)(res)
                  }
                }
                case Success(fieldFilter) => {
                  fieldsMaskFut
                    .flatMap { fieldsMask =>
                      /* RDF types allowed in mstream are: ntriples, nquads, jsonld & jsonldq
                       * since, the jsons are not realy RDF, just flattened json of infoton per line,
                       * there is no need to tnforce subject uniquness. but ntriples, and nquads
                       * which split infoton into statements (subject-predicate-object triples) per line,
                       * we don't want different versions to "mix" and we enforce uniquness only in this case
                       */
                      val forceUniqueness: Boolean = withHistory && (formatType match {
                        case RdfType(NquadsFlavor) => true
                        case RdfType(NTriplesFlavor) => true
                        case _ => false
                      })
                      val formatter = formatterManager.getFormatter(
                        format = formatType,
                        timeContext = timeContext,
                        host = request.host,
                        uri = request.uri,
                        pretty = false,
                        callback = request.queryString.get("callback").flatMap(_.headOption),
                        fieldFilters = fieldFilter,
                        offset = Some(offset.toLong),
                        length = Some(500L),
                        withData = withData,
                        withoutMeta = !withMeta,
                        filterOutBlanks = true,
                        forceUniqueness = forceUniqueness
                      ) // cleanSystemBlanks set to true, so we won't output all the meta information we usaly output.
                      // it get's messy with streaming. we don't want each chunk to show the "document context"

                      val datesFilter = {
                        if (from.isEmpty && to.isEmpty) None
                        else Some(DatesFilter(from, to))
                      }
                      streams
                        .multiScrollSource(pathFilter = pathFilter,
                          fieldFilter = fieldFilter,
                          datesFilter = datesFilter,
                          withHistory = withHistory,
                          withDeleted = withDeleted)
                        .map {
                          case (source, hits) => {
                            val s = streams.scrollSourceToByteString(source,
                              formatter,
                              withData.isDefined,
                              withHistory,
                              length,
                              fieldsMask)
                            Ok.chunked(s)
                              .as(overrideMimetype(formatter.mimetype, request)._2)
                              .withHeaders("X-CM-WELL-N" -> hits.toString)
                          }
                        }
                        .recover(errorHandler)
                    }
                    .recover(errorHandler)
                }
              }
              .recover(errorHandler)
          }
        }
      }
      .recover(asyncErrorHandler)
      .get

  private def handleSuperStream(request: Request[AnyContent]): Future[Result] =
    request
      .getQueryString("qp")
      .fold(Success(None): Try[Option[RawFieldFilter]])(FieldFilterParser.parseQueryParams(_).map(Some.apply))
      .map { qpOpt =>
        val normalizedPath = normalizePath(request.path)
        val from = DateParser.parseDate(request.getQueryString("from").getOrElse(""), FromDate).toOption
        val to = DateParser.parseDate(request.getQueryString("to").getOrElse(""), ToDate).toOption
        val offset = 0
        //request.getQueryString("offset").flatMap(asInt).getOrElse(0)
        val withDescendants = request.queryString.keySet("with-descendants") || request.queryString.keySet("recursive")
        val withHistory = request.queryString.keySet("with-history")
        val withDeleted = request.queryString.keySet("with-deleted")
        val withMeta = request.queryString.keySet("with-meta")
        val length = request.getQueryString("length").flatMap(asLong)
        val parallelism = request.getQueryString("parallelism").flatMap(asInt).getOrElse(Settings.sstreamParallelism)
        val pathFilter = Some(PathFilter(normalizedPath, withDescendants))
        val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)
        val fieldsMaskFut = extractFieldsMask(request, typesCache, cmwellRDFHelper, timeContext)
        val (withData, format) = {
          val wd = request.getQueryString("with-data")
          val frmt = request
            .getQueryString("format")
            .getOrElse({
              if (wd.isEmpty) "text" else "nt"
            })
          if (Set("nt", "ntriples", "nq", "nquads").exists(frmt.equalsIgnoreCase) || frmt.toLowerCase.startsWith(
            "json"
          )) {
            Some("text") -> frmt
          } else {
            None -> frmt
          }
        }
        format match {
          case f
            if !Set("text", "path", "tsv", "tab", "nt", "ntriples", "nq", "nquads")(f.toLowerCase) && !f.toLowerCase
              .startsWith("json") =>
            Future.successful(
              BadRequest(
                Json.obj("success" -> false,
                  "message" -> "not a streamable type (use 'text','tsv','ntriples', 'nquads', or any json)")
              )
            )
          case FormatExtractor(formatType) => {
            val fieldsFiltersFut = qpOpt.fold(Future.successful(Option.empty[FieldFilter]))(
              rff => RawFieldFilter.eval(rff, typesCache, cmwellRDFHelper, timeContext).map(Some.apply)
            )
            fieldsFiltersFut.transformWith {
              case Failure(err) => {
                val msg = s"failed to evaluate given qp [${qpOpt.fold("")(_.toString)}]"
                logger.error(msg, err)
                val res = FailedDependency(Json.obj("success" -> false, "message" -> msg))
                request.attrs.get(Attrs.RequestReceivedTimestamp).fold(Future.successful(res)) { reqStartTime =>
                  val timePassedInMillis = System.currentTimeMillis() - reqStartTime
                  if (timePassedInMillis > 9000L) Future.successful(res)
                  else SimpleScheduler.schedule((9500L - timePassedInMillis).millis)(res)
                }
              }
              case Success(fieldFilter) => {
                fieldsMaskFut.flatMap { fieldsMask =>
                  /* RDF types allowed in mstream are: ntriples, nquads, jsonld & jsonldq
                   * since, the jsons are not realy RDF, just flattened json of infoton per line,
                   * there is no need to tnforce subject uniquness. but ntriples, and nquads
                   * which split infoton into statements (subject-predicate-object triples) per line,
                   * we don't want different versions to "mix" and we enforce uniquness only in this case
                   */
                  val forceUniqueness: Boolean = withHistory && (formatType match {
                    case RdfType(NquadsFlavor) => true
                    case RdfType(NTriplesFlavor) => true
                    case _ => false
                  })
                  val formatter = formatterManager.getFormatter(
                    format = formatType,
                    timeContext = timeContext,
                    host = request.host,
                    uri = request.uri,
                    pretty = false,
                    callback = request.queryString.get("callback").flatMap(_.headOption),
                    fieldFilters = fieldFilter,
                    offset = Some(offset.toLong),
                    length = Some(500L),
                    withData = withData,
                    withoutMeta = !withMeta,
                    filterOutBlanks = true,
                    forceUniqueness = forceUniqueness
                  ) // cleanSystemBlanks set to true, so we won't output all the meta information we usaly output.
                  // it get's messy with streaming. we don't want each chunk to show the "document context"

                  streams
                    .superScrollSource(
                      pathFilter = pathFilter,
                      fieldFilter = fieldFilter,
                      datesFilter = Some(DatesFilter(from, to)),
                      paginationParams = PaginationParams(offset, 500),
                      withHistory = withHistory,
                      withDeleted = withDeleted,
                      parallelism = parallelism
                    )
                    .map {
                      case (src, hits) =>
                        val s = streams.scrollSourceToByteString(src,
                          formatter,
                          withData.isDefined,
                          withHistory,
                          length,
                          fieldsMask)
                        Ok.chunked(s)
                          .as(overrideMimetype(formatter.mimetype, request)._2)
                          .withHeaders("X-CM-WELL-N" -> hits.toString)
                    }
                }
              }
            }
          }
        }
      }
      .recover(asyncErrorHandler)
      .get

  private def handleStream(request: Request[AnyContent]): Future[Result] =
    request
      .getQueryString("qp")
      .fold(Success(None): Try[Option[RawFieldFilter]])(FieldFilterParser.parseQueryParams(_).map(Some.apply))
      .map { qpOpt =>
        val normalizedPath = normalizePath(request.path)
        val from = DateParser.parseDate(request.getQueryString("from").getOrElse(""), FromDate).toOption
        val to = DateParser.parseDate(request.getQueryString("to").getOrElse(""), ToDate).toOption
        val withDescendants = request.queryString.keySet("with-descendants") || request.queryString.keySet("recursive")
        val withHistory = request.queryString.keySet("with-history")
        val withDeleted = request.queryString.keySet("with-deleted")
        val withMeta = request.queryString.keySet("with-meta")
        val debugLog = request.queryString.keySet("debug-log")
        val scrollTtl = request.getQueryString("session-ttl").flatMap(asLong).getOrElse(3600L).min(3600L)
        val chunkSize = request.getQueryString("chunk-size").flatMap(asInt).getOrElse(500)
        val length = request.getQueryString("length").flatMap(asLong)
        val pathFilter = Some(PathFilter(normalizedPath, withDescendants))
        val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)
        val fieldsMaskFut = extractFieldsMask(request, typesCache, cmwellRDFHelper, timeContext)
        val (withData, format) = {
          val wd = request.getQueryString("with-data")
          val frmt = request
            .getQueryString("format")
            .getOrElse({
              if (wd.isEmpty) "text" else "nt"
            })
          if (Set("nt", "ntriples", "nq", "nquads").exists(frmt.equalsIgnoreCase) || frmt.toLowerCase.startsWith(
            "json"
          )) {
            Some("text") -> frmt
          } else {
            None -> frmt
          }
        }
        (format match {
          case f
            if !Set("text", "path", "tsv", "tab", "nt", "ntriples", "nq", "nquads")(f.toLowerCase) && !f.toLowerCase
              .startsWith("json") =>
            Future.successful(
              BadRequest(
                Json.obj(
                  "success" -> false,
                  "message" -> "not a streamable type (use any json, or one of: 'text','tsv','ntriples', or 'nquads')"
                )
              )
            )
          case FormatExtractor(formatType) => {
            val fieldsFiltersFut = qpOpt.fold(Future.successful(Option.empty[FieldFilter]))(
              rff => RawFieldFilter.eval(rff, typesCache, cmwellRDFHelper, timeContext).map(Some.apply)
            )
            fieldsFiltersFut.transformWith {
              case Failure(err) => {
                val msg = s"failed to evaluate given qp [${qpOpt.fold("")(_.toString)}]"
                logger.error(msg, err)
                val res = FailedDependency(Json.obj("success" -> false, "message" -> msg))
                request.attrs.get(Attrs.RequestReceivedTimestamp).fold(Future.successful(res)) { reqStartTime =>
                  val timePassedInMillis = System.currentTimeMillis() - reqStartTime
                  if (timePassedInMillis > 9000L) Future.successful(res)
                  else SimpleScheduler.schedule((9500L - timePassedInMillis).millis)(res)
                }
              }
              case Success(fieldFilter) => {
                fieldsMaskFut.flatMap { fieldsMask =>
                  /* RDF types allowed in stream are: ntriples, nquads, jsonld & jsonldq
                   * since, the jsons are not realy RDF, just flattened json of infoton per line,
                   * there is no need to tnforce subject uniquness. but ntriples, and nquads
                   * which split infoton into statements (subject-predicate-object triples) per line,
                   * we don't want different versions to "mix" and we enforce uniquness only in this case
                   */
                  val forceUniqueness: Boolean = withHistory && (formatType match {
                    case RdfType(NquadsFlavor) => true
                    case RdfType(NTriplesFlavor) => true
                    case _ => false
                  })
                  val formatter = formatterManager.getFormatter(
                    format = formatType,
                    timeContext = timeContext,
                    host = request.host,
                    uri = request.uri,
                    pretty = false,
                    callback = request.queryString.get("callback").flatMap(_.headOption),
                    fieldFilters = fieldFilter,
                    withData = withData,
                    withoutMeta = !withMeta,
                    filterOutBlanks = true,
                    forceUniqueness = forceUniqueness
                  )

                  lazy val id = cmwell.util.numeric.Radix64.encodeUnsigned(request.id)

                  val debugLogID = if (debugLog) Some(id) else None

                  streams
                    .scrollSource(
                      pathFilter = pathFilter,
                      fieldFilters = fieldFilter,
                      datesFilter = Some(DatesFilter(from, to)),
                      paginationParams = PaginationParams(0, chunkSize),
                      scrollTTL = scrollTtl,
                      withHistory = withHistory,
                      withDeleted = withDeleted,
                      debugLogID = debugLogID
                    )
                    .map {
                      case (src, hits) =>
                        val s: Source[ByteString, NotUsed] = {
                          val srcWithDebug = if (debugLog) src.via {
                            new StreamEventInspector(
                              onUpstreamFinishInspection = () => logger.info(s"scrollSource<->scrollSourceToByteString [$id] onUpstreamFinish"),
                              onUpstreamFailureInspection = error => logger.error(s"scrollSource<->scrollSourceToByteString [$id] onUpstreamFailure", error),
                              onDownstreamFinishInspection = () => logger.info(s"scrollSource<->scrollSourceToByteString [$id] onDownstreamFinish"),
                              onPullInspection = () => logger.info(s"scrollSource<->scrollSourceToByteString [$id] onPull"),
                              onPushInspection = {
                                case IterationResults(_, totalHits, iSeqOpt, _, _) =>
                                  val infotonData = iSeqOpt.fold("infoton sequence is None")(iSeq =>
                                    s"infoton count: ${iSeq.size}, first uuid: ${iSeq.headOption.fold("none")(_.uuid)}")
                                  logger.info(s"scrollSource<->scrollSourceToByteString [$id] onPush(totalHits: $totalHits, $infotonData)")
                              }
                            )
                          } else src
                          val scrollSourceToByteString = streams.scrollSourceToByteString(srcWithDebug,
                            formatter,
                            withData.isDefined,
                            withHistory,
                            length,
                            fieldsMask)
                          if (debugLog) scrollSourceToByteString.via {
                            new StreamEventInspector(
                              onUpstreamFinishInspection = () => logger.info(s"scrollSourceToByteString<->Play [$id] onUpstreamFinish"),
                              onUpstreamFailureInspection = error => logger.error(s"scrollSourceToByteString<->Play [$id] onUpstreamFailure", error),
                              onDownstreamFinishInspection = () => logger.info(s"scrollSourceToByteString<->Play [$id] onDownstreamFinish"),
                              onPullInspection = () => logger.info(s"scrollSourceToByteString<->Play [$id] onPull"),
                              onPushInspection = bytes => {
                                val all = bytes.utf8String
                                val elem = {
                                  if (bytes.isEmpty) ""
                                  else all.lines.next()
                                }
                                logger.info(
                                  s"""scrollSourceToByteString<->Play [$id] onPush(first line: "$elem", num of lines: ${all.lines.size},"""
                                    + s" num of chars: ${all.length})")
                              }
                            )
                          } else scrollSourceToByteString
                        }
                        val headers = {
                          if (debugLog) List("X-CM-WELL-N" -> hits.toString, "X-CM-WELL-LOG-ID" -> id)
                          else List("X-CM-WELL-N" -> hits.toString)
                        }
                        Ok.chunked(s).as(overrideMimetype(formatter.mimetype, request)._2).withHeaders(headers: _*)
                    }
                }
              }
            }
          }
        }).recover(errorHandler)
      }
      .recover(asyncErrorHandler)
      .get

  def generateSortedConsumeFieldFilters(qpOpt: Option[String],
                                        path: String,
                                        withDescendants: Boolean,
                                        withHistory: Boolean,
                                        withDeleted: Boolean,
                                        indexTime: Long,
                                        timeContext: Option[Long]): Future[SortedConsumeState] = {
    val pOpt = {
      if (path == "/" && withDescendants) None
      else Some(path)
    }

    qpOpt
      .fold[Future[Option[FieldFilter]]](Future.successful(None)) { qp =>
      FieldFilterParser.parseQueryParams(qp) match {
        case Failure(err) => Future.failed(err)
        case Success(rff) => RawFieldFilter.eval(rff, typesCache, cmwellRDFHelper, timeContext).map(Some.apply)
      }
    }
      .map { ffOpt =>
        SortedConsumeState(indexTime, pOpt, withHistory, withDeleted, withDescendants, ffOpt)
      }
  }

  private def transformFieldFiltersForConsumption(fieldFilters: Option[FieldFilter],
                                                  timeStamp: Long,
                                                  now: Long): FieldFilter = {
    val fromOp =
      if (timeStamp != 0L) GreaterThan
      else GreaterThanOrEquals

    val fromFilter = FieldFilter(Must, fromOp, "system.indexTime", timeStamp.toString)
    val uptoFilter = FieldFilter(Must, LessThan, "system.indexTime", (now - 10000).toString)
    val rangeFilters = List(fromFilter, uptoFilter)

    fieldFilters match {
      case None => MultiFieldFilter(Must, rangeFilters)
      case Some(should@SingleFieldFilter(Should, _, _, _)) =>
        MultiFieldFilter(Must, should.copy(fieldOperator = Must) :: rangeFilters)
      case Some(ff) => MultiFieldFilter(Must, ff :: rangeFilters)
    }
  }

  private def handleQueueStream(request: Request[AnyContent]): Future[Result] = {

    val indexTime: Long = request.getQueryString("index-time").flatMap(asLong).getOrElse(0L)
    val withMeta = request.queryString.keySet("with-meta")
    val length = request.getQueryString("length").flatMap(asLong)
    val lengthHint = request.getQueryString("length-hint").flatMap(asInt).getOrElse(3000)
    val normalizedPath = normalizePath(request.path)
    val qpOpt = request.getQueryString("qp")
    //deprecated!
    //    val from = request.getQueryString("from")
    //    val to = request.getQueryString("to")
    val withDescendants = request.queryString.keySet("with-descendants") || request.queryString.keySet("recursive")
    val withHistory = request.queryString.keySet("with-history")
    val withDeleted = request.queryString.keySet("with-deleted")
    val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)
    val (withData, format) = {
      val wd = request.getQueryString("with-data")
      val frmt = request
        .getQueryString("format")
        .getOrElse({
          if (wd.isEmpty) "text" else "nt"
        })
      if (Set("nt", "ntriples", "nq", "nquads").exists(frmt.equalsIgnoreCase) || frmt.toLowerCase.startsWith("json"))
        Some("text") -> frmt
      else None -> frmt
    }

    format match {
      case f
        if !Set("text", "path", "tsv", "tab", "nt", "ntriples", "nq", "nquads")(f.toLowerCase) && !f.toLowerCase
          .startsWith("json") =>
        Future.successful(
          BadRequest(
            Json
              .obj("success" -> false,
                "message" -> "not a streamable type (use any json, or one of: 'text','tsv','ntriples', or 'nquads')")
          )
        )
      case FormatExtractor(formatType) => {
        /* RDF types allowed in stream are: ntriples, nquads, jsonld & jsonldq
         * since, the jsons are not realy RDF, just flattened json of infoton per line,
         * there is no need to enforce subject uniquness. but ntriples, and nquads
         * which split infoton into statements (subject-predicate-object triples) per line,
         * we don't want different versions to "mix" and we enforce uniquness only in this case
         */
        val forceUniqueness: Boolean = withHistory && (formatType match {
          case RdfType(NquadsFlavor) => true
          case RdfType(NTriplesFlavor) => true
          case _ => false
        })

        generateSortedConsumeFieldFilters(
          qpOpt = qpOpt,
          path = normalizedPath,
          withDescendants = withDescendants,
          withHistory = withHistory,
          withDeleted = withDeleted,
          indexTime = indexTime,
          timeContext = timeContext
        ).transformWith {
          case Failure(err) => {
            val msg = s"failed to evaluate given qp [${qpOpt.fold("")(_.toString)}]"
            logger.error(msg, err)
            val res = FailedDependency(Json.obj("success" -> false, "message" -> msg))
            request.attrs.get(Attrs.RequestReceivedTimestamp).fold(Future.successful(res)) { reqStartTime =>
              val timePassedInMillis = System.currentTimeMillis() - reqStartTime
              if (timePassedInMillis > 9000L) Future.successful(res)
              else SimpleScheduler.schedule((9500L - timePassedInMillis).millis)(res)
            }
          }
          case Success(SortedConsumeState(firstTimeStamp, path, history, deleted, descendants, fieldFilters)) => {

            val formatter = formatterManager.getFormatter(
              format = formatType,
              timeContext = timeContext,
              host = request.host,
              uri = request.uri,
              pretty = false,
              fieldFilters = fieldFilters,
              withData = withData,
              withoutMeta = !withMeta,
              filterOutBlanks = true,
              forceUniqueness = forceUniqueness
            )

            import cmwell.ws.Streams._

            val src = streams.qStream(firstTimeStamp, path, history, deleted, descendants, lengthHint, fieldFilters)

            val ss: Source[ByteString, NotUsed] = length.fold {
              if (withData.isEmpty)
                src.via(Flows.searchThinResultToByteString(formatter))
              else
                src
                  .via(Flows.searchThinResultToFatInfoton(crudServiceFS))
                  .via(Flows.infotonToByteString(formatter))
            } { l =>
              if (withData.isEmpty)
                src
                  .take(l)
                  .via(Flows.searchThinResultToByteString(formatter))
              else
                src
                  .via(Flows.searchThinResultToFatInfoton(crudServiceFS))
                  .take(l)
                  .via(Flows.infotonToByteString(formatter))
            }

            val contentType = {
              if (formatType.mimetype.startsWith("application/json"))
                overrideMimetype("application/json-seq;charset=UTF8", request)._2
              else
                overrideMimetype(formatType.mimetype, request)._2
            }

            Future.successful(Ok.chunked(ss.batch(128, identity)(_ ++ _)).as(contentType)) //TODO: `.withHeaders("X-CM-WELL-N" -> total.toString)`
          }
        }
          .recover(errorHandler)
      }
    }
  }

  def getQueryString(k: String)(implicit m: Map[String, Seq[String]]): Option[String] = m.get(k).flatMap(_.headOption)

  case class ExtractURLFormEnc(path: String) extends Action[Either[CMWellRequest, RawBuffer]] {

    def apply(request: Request[Either[CMWellRequest, RawBuffer]]): Future[Result] =
      Try {
        request.body match {
          case Right(b) => handlePutInfoton(path)(request.map(_ => b))
          case Left(CreateConsumer(path, qp)) =>
            handleCreateConsumer(path, request.attrs.get(Attrs.RequestReceivedTimestamp))(qp)
          case Left(Search(path, base, host, uri, qp)) =>
            handleSearch(path, base, host, uri, request.attrs.get(Attrs.RequestReceivedTimestamp))(qp)
        }
      }.recover {
        case e: Throwable =>
          Future.successful(InternalServerError(e.getMessage + "\n" + cmwell.util.exceptions.stackTraceToString(e)))
      }.get

    lazy val parser = parse.using(
      rh =>
        rh.mediaType match {
          case Some(MediaType("application", "x-www-form-urlencoded", _))
            if rh.getQueryString("op").contains("create-consumer") =>
            parse.formUrlEncoded.map(m => Left(CreateConsumer(rh, m)))
          case Some(MediaType("application", "x-www-form-urlencoded", _))
            if rh.getQueryString("op").contains("search") =>
            parse.formUrlEncoded.map(m => Left(Search(rh, m)))
          case _ => parse.raw.map(Right.apply)
        }
    )

    override def executionContext: ExecutionContext = ec
  }

  def handlePost(path: String) = ExtractURLFormEnc(path)

  private def handleCreateConsumerRequest(request: Request[AnyContent]): Future[Result] =
    handleCreateConsumer(request.path, request.attrs.get(Attrs.RequestReceivedTimestamp))(request.queryString)

  private def handleCreateConsumer(path: String, requestReceivedTimestamp: Option[Long])(
    createConsumerParams: Map[String, Seq[String]]
  ): Future[Result] =
    Try {
      val indexTime = createConsumerParams.get("index-time").flatMap(_.headOption.flatMap(asLong))
      val normalizedPath = normalizePath(path)
      val qpOpt = createConsumerParams.get("qp").flatMap(_.headOption)
      val withDescendants = createConsumerParams.contains("with-descendants") || createConsumerParams.contains(
        "recursive"
      )
      val withHistory = createConsumerParams.contains("with-history")
      val withDeleted = createConsumerParams.contains("with-deleted")
      val lengthHint = createConsumerParams.get("length-hint").flatMap(_.headOption.flatMap(asLong))
      val consumeStateFut: Future[ConsumeState] = {
        val f = generateSortedConsumeFieldFilters(qpOpt,
          normalizedPath,
          withDescendants,
          withHistory,
          withDeleted,
          indexTime.getOrElse(0L),
          requestReceivedTimestamp)
        lengthHint.fold[Future[ConsumeState]](f)(lh => f.map(_.asBulk(lh)))
      }
      consumeStateFut
        .transformWith {
          case Failure(err) => {
            val msg = s"failed to evaluate given qp [${qpOpt.fold("")(_.toString)}]"
            logger.error(msg, err)
            val res = FailedDependency(Json.obj("success" -> false, "message" -> msg))
            requestReceivedTimestamp.fold(Future.successful(res)) { reqStartTime =>
              val timePassedInMillis = System.currentTimeMillis() - reqStartTime
              if (timePassedInMillis > 9000L) Future.successful(res)
              else SimpleScheduler.schedule((9500L - timePassedInMillis).millis)(res)
            }
          }
          case Success(scs) => {
            val id = ConsumeState.encode(scs)
            Future.successful(Ok("").withHeaders("X-CM-WELL-POSITION" -> id))
          }
        }
        .recover(errorHandler)
    }.recover(asyncErrorHandler).get

  // This method is to enable to access handleConsume from routes.
  def handleConsumeRoute = Action.async { implicit request =>
    if (request.queryString.isEmpty) Future.successful(Ok(views.txt._consume(request)))
    else handleConsume(request)
  }

  // This method is to enable to access BulkScrollHandler.handle from routes.
  def handleBulkConsumeRoute = Action.async { implicit request =>
    if (request.queryString.isEmpty) Future.successful(Ok(views.txt._bulkConsume(request)))
    else bulkScrollHandler.handle(request)
  }

  private[controllers] def handleConsume(request: Request[AnyContent]): Future[Result] =
    Try {
      val sortedIteratorID = request
        .getQueryString("position")
        .getOrElse(throw new IllegalArgumentException("`position` parameter is required"))

      //properties that needs to be re-sent every iteration
      val xg = request.getQueryString("xg")
      val (yg, ygChunkSize) = request
        .getQueryString("yg")
        .fold(Option.empty[String] -> 0)(
          Some(_) -> request.getQueryString("yg-chunk-size").flatMap(asInt).getOrElse(10)
        )
      val (gqp, gqpChunkSize) = request
        .getQueryString("gqp")
        .fold(Option.empty[String] -> 0)(
          Some(_) -> request.getQueryString("gqp-chunk-size").flatMap(asInt).getOrElse(10)
        )
      val (requestedFormat, withData) = {
        val (f, b) = extractInferredFormatWithData(request, "json")
        f -> (b || yg.isDefined || xg.isDefined) //infer `with-data` implicitly, and don't fail the request
      }
      val isSimpleConsume = !(xg.isDefined || yg.isDefined || gqp.isDefined)

      def wasSupplied(queryParamKey: String) = request.queryString.keySet(queryParamKey)
      // scalastyle:off
      if (wasSupplied("qp"))
        Future.successful(BadRequest("you can't specify `qp` together with `position` (`qp` is meant to be used only in the first iteration request. after that, continue iterating using the received `position`)"))
      else if (wasSupplied("from") || wasSupplied("to"))
        Future.successful(BadRequest("`from`/`to` is determined in the beginning of the iteration. can't specify together with `position`"))
      else if (wasSupplied("indexTime"))
        Future.successful(BadRequest("`indexTime` is determined in the beginning of the iteration. can't specify together with `position`"))
      else if (wasSupplied("with-descendants") || wasSupplied("recursive"))
        Future.successful(BadRequest("`with-descendants`/`recursive` is determined in the beginning of the iteration. can't specify together with `position`"))
      else if (wasSupplied("with-history"))
        Future.successful(BadRequest("`with-history` is determined in the beginning of the iteration. can't specify together with `position`"))
      else if (wasSupplied("with-deleted"))
        Future.successful(BadRequest("`with-deleted` is determined in the beginning of the iteration. can't specify together with `position`"))
      // scalastyle:on
      else {
        val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)
        val sortedIteratorStateTry = ConsumeState.decode[SortedConsumeState](sortedIteratorID)
        val hardLimit = if (isSimpleConsume) Settings.consumeSimpleChunkSize else Settings.consumeExpandableChunkSize
        val lengthHint = request
          .getQueryString("length-hint")
          .flatMap(asInt)
          .getOrElse(
            ConsumeState
              .decode[BulkConsumeState](sortedIteratorID)
              .toOption
              .collect {
                case b if b.threshold <= Settings.maxLength => b.threshold.toInt
              }
              .getOrElse(hardLimit)
          ).min(hardLimit) //Making sure length hint is not bigger than max

        val debugInfo = request.queryString.keySet("debug-info")

        sortedIteratorStateTry
          .map {
            case sortedConsumeState@SortedConsumeState(timeStamp,
            path,
            history,
            deleted,
            descendants,
            fieldFilters) => {

              val pf = path.map(PathFilter(_, descendants))
              val ffs = transformFieldFiltersForConsumption(fieldFilters,
                timeStamp,
                request.attrs(Attrs.RequestReceivedTimestamp))
              val pp = PaginationParams(0, lengthHint)
              val fsp = FieldSortParams(List("system.indexTime" -> Asc))

              val future = crudServiceFS.thinSearch(
                pathFilter = pf,
                fieldFilters = Some(ffs),
                datesFilter = None,
                paginationParams = pp,
                withHistory = history,
                withDeleted = deleted,
                fieldSortParams = fsp,
                debugInfo = debugInfo
              )

              val (contentType, formatter) = requestedFormat match {
                case FormatExtractor(formatType) =>
                  val f = formatterManager.getFormatter(
                    format = formatType,
                    timeContext = timeContext,
                    host = request.host,
                    uri = request.uri,
                    pretty = request.queryString.keySet("pretty"),
                    callback = request.queryString.get("callback").flatMap(_.headOption),
                    fieldFilters = fieldFilters
                  )

                  val m =
                    if (formatType.mimetype.startsWith("application/json"))
                      overrideMimetype("application/json-seq;charset=UTF8", request)._2
                    else
                      overrideMimetype(formatType.mimetype, request)._2

                  (m, f)
              }

              future
                .flatMap {
                  case sr: SearchThinResults if sr.thinResults.isEmpty => {
                    if (debugInfo) {
                      logger.info(
                        s"""will emit 204 for search params:
                           |pathFilter       = $pf,
                           |fieldFilters     = $ffs,
                           |paginationParams = $pp,
                           |withHistory      = $history,
                           |fieldSortParams  = $fsp""".stripMargin)
                    }
                    val result = new Status(204)
                      .as(contentType)
                      .withHeaders("X-CM-WELL-POSITION" -> sortedIteratorID, "X-CM-WELL-N-LEFT" -> "0")
                    Future.successful(result)
                  }
                  case SearchThinResults(total, _, _, results, _) if results.nonEmpty => {

                    val idxT = results.maxBy(_.indexTime).indexTime //infotons.maxBy(_.indexTime.getOrElse(0L)).indexTime.getOrElse(0L)

                    val fieldsMaskFut = extractFieldsMask(request.getQueryString("fields"),
                      typesCache,
                      cmwellRDFHelper,
                      request.attrs.get(Attrs.RequestReceivedTimestamp))

                    // last chunk
                    if (results.length >= total)
                      fieldsMaskFut.flatMap { fieldsMask =>
                        expandSearchResultsForSortedIteration(results,
                          sortedConsumeState.copy(from = idxT),
                          total,
                          formatter,
                          contentType,
                          xg,
                          yg,
                          gqp,
                          ygChunkSize,
                          gqpChunkSize,
                          timeContext,
                          fieldsMask)
                      }
                    //regular chunk with more than 1 indexTime
                    else if (results.exists(_.indexTime != idxT)) {
                      fieldsMaskFut.flatMap { fieldsMask =>
                        val newResults = results.filter(_.indexTime < idxT)
                        val id = sortedConsumeState.copy(from = idxT - 1)
                        //expand the infotons with yg/xg, but only after filtering out the infotons with the max indexTime
                        expandSearchResultsForSortedIteration(newResults,
                          id,
                          total,
                          formatter,
                          contentType,
                          xg,
                          yg,
                          gqp,
                          ygChunkSize,
                          gqpChunkSize,
                          timeContext,
                          fieldsMask)
                      }
                    }
                    //all the infotons in current chunk have the same indexTime
                    else {

                      val ffs2 = {
                        val eqff = FieldFilter(Must, Equals, "system.indexTime", idxT.toString)
                        fieldFilters.fold[FieldFilter](eqff) { ff =>
                          MultiFieldFilter(Must, List(ff, eqff))
                        }
                      }

                      val scrollFuture = streams.scrollSource(pathFilter = pf,
                        fieldFilters = Some(ffs2),
                        withHistory = history,
                        withDeleted = deleted)

                      scrollFuture
                        .flatMap {
                          //if by pure luck, the chunk length is exactly equal to the number of infotons in cm-well containing this same indexTime
                          case (_, hits) if hits <= results.size =>
                            fieldsMaskFut.flatMap { fieldsMask =>
                              expandSearchResultsForSortedIteration(results,
                                sortedConsumeState.copy(from = idxT),
                                total,
                                formatter,
                                contentType,
                                xg,
                                yg,
                                gqp,
                                ygChunkSize,
                                gqpChunkSize,
                                timeContext,
                                fieldsMask)
                            }
                          // if we were asked to expand chunk, but need to respond with a chunked response
                          // (workaround: try increasing length or search directly with adding `system.indexTime::${idxT}`)
                          case _ if xg.isDefined || yg.isDefined =>
                            Future.successful(
                              UnprocessableEntity(
                                s"encountered a large chunk which cannot be expanded using xg/yg. (indexTime=$idxT)"
                              )
                            )
                          //chunked response
                          case (iterationResultsEnum, hits) => {
                            logger.info(s"sorted iteration encountered a large chunk [indexTime = $idxT]")

                            val id = ConsumeState.encode(sortedConsumeState.copy(from = idxT))

                            fieldsMaskFut.map { fieldsMask =>
                              val src =
                                streams.scrollSourceToByteString(iterationResultsEnum,
                                  formatter,
                                  withData,
                                  history,
                                  None,
                                  fieldsMask)

                              Ok
                                .chunked(src)
                                .as(contentType)
                                .withHeaders("X-CM-WELL-POSITION" -> id, "X-CM-WELL-N-LEFT" -> (total - hits).toString)
                            }
                          }
                        }
                        .recover(errorHandler)
                    }
                  }
                }
                .recover(errorHandler)
            }
          }
          .recover(asyncErrorHandler)
          .get
      }
    }.recover(asyncErrorHandler).get

  def expandSearchResultsForSortedIteration(newResults: immutable.Seq[SearchThinResult],
                                            sortedIteratorState: SortedConsumeState,
                                            total: Long,
                                            formatter: Formatter,
                                            contentType: String,
                                            xg: Option[String],
                                            yg: Option[String],
                                            gqp: Option[String],
                                            ygChunkSize: Int,
                                            gqpChunkSize: Int,
                                            timeContext: Option[Long],
                                            fieldsMask: Set[String]): Future[Result] = {

    val id = ConsumeState.encode(sortedIteratorState)

    if (formatter.format.isThin) {
      require(
        xg.isEmpty && yg.isEmpty,
        "Thin formats does not carry data, and thus cannot be expanded! (xg/yg/gqp supplied together with a thin format)"
      )
      val body = FormatterManager.formatFormattableSeq(newResults, formatter)
      Future.successful(
        Ok(body)
          .as(contentType)
          .withHeaders("X-CM-WELL-POSITION" -> id, "X-CM-WELL-N-LEFT" -> (total - newResults.length).toString)
      )
    } else if (xg.isEmpty && yg.isEmpty && gqp.isEmpty)
      Future.successful(
        Ok.chunked(
          Source(newResults)
            .via(Streams.Flows.searchThinResultToFatInfoton(crudServiceFS))
            .map(_.masked(fieldsMask))
            .via(Streams.Flows.infotonToByteString(formatter))
        )
          .as(contentType)
          .withHeaders("X-CM-WELL-POSITION" -> id, "X-CM-WELL-N-LEFT" -> (total - newResults.length).toString)
      )
    else {

      import cmwell.util.concurrent.travector

      travector(newResults)(str => crudServiceFS.getInfotonByUuidAsync(str.uuid).map(_ -> str.uuid)).flatMap {
        newInfotonsBoxes =>
          val newInfotons = newInfotonsBoxes.collect { case (FullBox(i), _) => i }

          if (newInfotons.length != newInfotonsBoxes.length) {
            val (fails, nones) = cmwell.util.collections.partitionWith(newInfotonsBoxes.filter(_._1.isEmpty)) {
              case (BoxedFailure(e), u) => Left(e -> u)
              case (EmptyBox, u) => Right(u)
              case _ => !!!
            }
            if (nones.nonEmpty) logger.error("some uuids could not be retrieved: " + nones.mkString("[", ",", "]"))
            fails.foreach {
              case (e, u) => logger.error(s"uuid [$u] failed", e)
            }
          }

          val gqpModified = gqp.fold(Future.successful(newInfotons))(
            gqpFilter(_, newInfotons, cmwellRDFHelper, typesCache, gqpChunkSize, timeContext).map(_.toVector)
          )
          gqpModified.flatMap { infotonsAfterGQP =>
            //TODO: xg/yg handling should be factor out (DRY principle)
            val ygModified = yg match {
              case Some(ygp) if infotonsAfterGQP.nonEmpty => {
                pathExpansionParser(ygp, infotonsAfterGQP, ygChunkSize, cmwellRDFHelper, typesCache, timeContext).map {
                  case (ok, infotonsAfterYg) => ok -> infotonsAfterYg
                }
              }
              case _ => Future.successful(true -> infotonsAfterGQP)
            }

            val maskedYgModified = ygModified.map { case (ok, infotons) => ok -> infotons.map(_.masked(fieldsMask)) }

            maskedYgModified.flatMap {
              case (false, infotonsAfterYg) => {
                val body = FormatterManager.formatFormattableSeq(infotonsAfterYg, formatter)
                val result = InsufficientStorage(body)
                  .as(contentType)
                  .withHeaders("X-CM-WELL-POSITION" -> id,
                    "X-CM-WELL-N-LEFT" -> (total - infotonsAfterGQP.length).toString)
                Future.successful(result)
              }
              case (true, infotonsAfterYg) if infotonsAfterYg.isEmpty || xg.isEmpty => {
                val body = FormatterManager.formatFormattableSeq(infotonsAfterYg, formatter)
                val result = {
                  if (newInfotonsBoxes.exists(_._1.isEmpty)) PartialContent(body)
                  else Ok(body)
                }

                Future.successful(
                  result
                    .as(contentType)
                    .withHeaders("X-CM-WELL-POSITION" -> id,
                      "X-CM-WELL-N-LEFT" -> (total - newInfotonsBoxes.length).toString)
                )
              }
              case (true, infotonsAfterYg) => {
                deepExpandGraph(xg.get, infotonsAfterYg, cmwellRDFHelper, typesCache, timeContext).map {
                  case (_, infotonsAfterXg) =>
                    val body = FormatterManager.formatFormattableSeq(infotonsAfterXg, formatter)
                    val result = {
                      if (newInfotonsBoxes.exists(_._1.isEmpty)) PartialContent(body)
                      else Ok(body)
                    }

                    result
                      .as(contentType)
                      .withHeaders("X-CM-WELL-POSITION" -> id,
                        "X-CM-WELL-N-LEFT" -> (total - newInfotonsBoxes.length).toString)
                }
              }
            }
          }
      }
    }
  }

  // This method is to enable to access handleScroll from routes.
  def handleScrollRoute = Action.async { implicit request =>
    handleScroll(request)
  }

  val (actorRefsCachedFactory, putInCache) = {
    val c: Cache[String, Future[Option[ActorRef]]] = CacheBuilder.newBuilder().maximumSize(100).build()
    val func: String => Future[Option[ActorRef]] = s => {
      Grid.getRefFromSelection(Grid.selectByPath(s), 10, 1.second).transform {
        case Failure(_: NoSuchElementException) => Success(None)
        case otherTry => otherTry.map(Some.apply)
      }
    }

    val putRefreshedValueEagerlyInCache: (String, ActorRef) => Unit =
      (k: String, v: ActorRef) => {
        c.put(k, Future.successful(Some(v)))
      }

    (cmwell.zcache.L1Cache
      .memoizeWithCache[String, Option[ActorRef]](func)(identity)(c)(ec)
      .andThen(_.transform {
        case Success(None) =>
          Failure(
            new NoSuchElementException("actor address was not found please see previous log for the exact reason why.")
          )
        case anotherNonEmptyTry => anotherNonEmptyTry.map(_.get)
      })) -> putRefreshedValueEagerlyInCache
  }

  /**
    * WARNING: using xg with iterator, is at the user own risk!
    * results may be cut off if expansion limit is exceeded,
    * but no warning can be emitted, since we use a chunked response,
    * and it is impossible to change status code or headers.
    *
    * @param request
    * @return
    */
  private def handleScroll(request: Request[AnyContent]): Future[Result] =
    Try {

      import akka.pattern.ask

      request
        .getQueryString("iterator-id")
        .fold(Future.successful(BadRequest("iterator-id query param is mandatory for this operation"))) {
          encodedActorAddress =>
            val xg = request.getQueryString("xg")
            val (yg, ygChunkSize) = request
              .getQueryString("yg")
              .fold(Option.empty[String] -> 0)(
                Some(_) -> request.getQueryString("yg-chunk-size").flatMap(asInt).getOrElse(10)
              )
            val scrollTtl = request.getQueryString("session-ttl").flatMap(asInt).getOrElse(15).min(60)
            val withDataFormat = request.getQueryString("with-data")
            val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)
            val withData =
              (withDataFormat.isDefined && withDataFormat.get.toLowerCase != "false") ||
                (withDataFormat.isEmpty && (yg.isDefined || xg.isDefined)) //infer `with-data` implicitly, and don't fail the request

            val fieldsMaskFut = extractFieldsMask(request, typesCache, cmwellRDFHelper, timeContext)

            logger.debug(s"Get chunk request received with: xg=$xg yg=$yg scrollTtl=$scrollTtl withData=$withData")

            if (!withData && xg.isDefined)
              Future.successful(BadRequest("you can't use `xg` without also specifying `with-data`!"))
            else {
              val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)
              val deadLine = request.attrs(Attrs.RequestReceivedTimestamp) + 7000
              val itStateEitherFuture: Future[Either[String, IterationState]] = {
                actorRefsCachedFactory(Base64.decodeBase64String(encodedActorAddress, "UTF-8")).flatMap { ar =>
                  (ar ? GetID) (akka.util.Timeout(10.seconds)).mapTo[IterationState].map {
                    case IterationState(_, wh, _) if wh && (yg.isDefined || xg.isDefined) => {
                      Left(
                        "iterator is defined to contain history. you can't use `xg` or `yg` operations on histories."
                      )
                    }
                    case msg => Right(msg)
                  }
                }
              }
              request.getQueryString("format").getOrElse("atom") match {
                case FormatExtractor(formatType) =>
                  itStateEitherFuture
                    .flatMap {
                      case Left(errMsg) => Future.successful(BadRequest(errMsg))
                      case Right(IterationState(scrollInput, withHistory, ar)) => {
                        val formatter = formatterManager.getFormatter(
                          format = formatType,
                          timeContext = timeContext,
                          host = request.host,
                          uri = request.uri,
                          pretty = request.queryString.keySet("pretty"),
                          callback = request.queryString.get("callback").flatMap(_.headOption),
                          withData = withDataFormat,
                          forceUniqueness = withHistory
                        )
                        val debugInfo = request.queryString.keySet("debug-info")
                        val scrollIterationResults = ftsScroll(scrollInput, scrollTtl + 5, withData, debugInfo)
                        val futureThatMayHang: Future[String] =
                          scrollIterationResults.flatMap { tmpIterationResults =>
                            fieldsMaskFut.flatMap { fieldsMask =>
                              val rv = createScrollIdDispatcherActorFromIteratorId(ScrollInput(tmpIterationResults.iteratorId),
                                withHistory,
                                scrollTtl.seconds)
                              val iterationResults = tmpIterationResults.copy(iteratorId = rv).masked(fieldsMask)
                              val ygModified = yg match {
                                case Some(ygp) if iterationResults.infotons.isDefined => {
                                  pathExpansionParser(ygp,
                                    iterationResults.infotons.get,
                                    ygChunkSize,
                                    cmwellRDFHelper,
                                    typesCache,
                                    timeContext).map {
                                    case (ok, infotons) => ok -> iterationResults.copy(infotons = Some(infotons))
                                  }
                                }
                                case _ => Future.successful(true -> iterationResults)
                              }

                              ygModified.flatMap {
                                case (ok, iterationResultsAfterYg) => {
                                  (xg, iterationResultsAfterYg.infotons) match {
                                    case t if t._1.isEmpty || t._2.isEmpty || !ok =>
                                      Future(formatter.render(iterationResultsAfterYg))
                                    case (Some(xgp), Some(infotons)) => {
                                      val fIterationResults =
                                        deepExpandGraph(xgp, infotons, cmwellRDFHelper, typesCache, timeContext).map {
                                          case (_, iseq) => iterationResultsAfterYg.copy(infotons = Some(iseq))
                                        }
                                      fIterationResults.map(formatter.render)
                                    }
                                  }
                                }
                              }
                            }
                          }

                        // initialGraceTime can become negative
                        // (think of a lengthy GC that will cause now to be after the dead line),
                        // but it's ok because the scheduler will start immidiately
                        val initialGraceTime = {
                          val now = System.currentTimeMillis()
                          if (now >= deadLine) Duration.Zero
                          else Duration(deadLine - now, MILLISECONDS)
                        }
                        val injectInterval = 3.seconds
                        val backOnTime: String => Result = { str =>
                          Ok(str).as(overrideMimetype(formatter.mimetype, request)._2)
                        }
                        val prependInjections: () => ByteString = formatter match {
                          case a: AtomFormatter => {
                            val it = Iterator.single(ByteString(a.xsltRef)) ++ Iterator.continually(
                              cmwell.ws.Streams.endln
                            )
                            () =>
                              it.next()
                          }
                          case _ =>
                            () =>
                              cmwell.ws.Streams.endln
                        }
                        val injectOriginalFutureWith: String => ByteString = ByteString(_, StandardCharsets.UTF_8)
                        val continueWithSource: Source[ByteString, NotUsed] => Result = { src =>
                          Ok.chunked(src).as(overrideMimetype(formatter.mimetype, request)._2)
                        }

                        guardHangingFutureByExpandingToSource[String, ByteString, Result](
                          futureThatMayHang,
                          initialGraceTime,
                          injectInterval
                        )(backOnTime, prependInjections, injectOriginalFutureWith, continueWithSource)
                      }
                    }
                    .recover {
                      case err: Throwable => {
                        val actorAddress = Base64.decodeBase64String(encodedActorAddress, "UTF-8")
                        val id = actorAddress.split('/').last
                        logger.error(s"[ID: $id] actor holding actual ES ID could not be found ($actorAddress)", err)
                        ExpectationFailed(
                          "it seems like the iterator-id provided is invalid. " +
                            "either it was already retrieved, or the specified session-ttl timeout exceeded, " +
                            s"or it was malformed. error has been logged with ID = $id"
                        )
                      }
                    }
                case unrecognized: String =>
                  Future.successful(BadRequest(s"unrecognized format requested: $unrecognized"))
              }
            }
        }
    }.recover(asyncErrorHandler).get

  private def ftsScroll(scrollInput: IterationStateInput, scrollTTL: Long, withData: Boolean, debugInfo:Boolean): Future[IterationResults] = {
    scrollInput match {
      case ScrollInput(scrollId) => crudServiceFS.scroll(scrollId, scrollTTL, withData, debugInfo)
      case StartScrollInput(pathFilter, fieldFilters, datesFilter, paginationParams, scrollTtl, withHistory, withDeleted, withData) =>
        crudServiceFS.startScroll(
          pathFilter,
          fieldFilters,
          datesFilter,
          paginationParams,
          scrollTtl,
          withHistory,
          withDeleted,
          debugInfo,
          withData)
      }
  }

  private def handleAggregate(request: Request[AnyContent]): Future[Result] =
    request
      .getQueryString("qp")
      .fold(Success(None): Try[Option[RawFieldFilter]])(FieldFilterParser.parseQueryParams(_).map(Some.apply))
      .map { qpOpt =>
        val normalizedPath = normalizePath(request.path)
        val from = DateParser.parseDate(request.getQueryString("from").getOrElse(""), FromDate).toOption
        val to = DateParser.parseDate(request.getQueryString("to").getOrElse(""), ToDate).toOption
        val length = request.getQueryString("length").flatMap(asInt).getOrElse(10)
        val offset = request.getQueryString("offset").flatMap(asInt).getOrElse(0)
        val debugInfo = request.queryString.keySet("debug-info")
        val withDescendants = request.queryString.keySet("with-descendants") || request.queryString.keySet("recursive")
        val pathFilter = if (normalizedPath.length > 1) Some(PathFilter(normalizedPath, withDescendants)) else None
        val withHistory = request.queryString.keySet("with-history")
        val rawAggregationsFilters = AggregationsFiltersParser.parseAggregationParams(request.getQueryString("ap"))
        val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)

        rawAggregationsFilters match {
          case Success(raf) =>
            val apfut = Future.traverse(raf)(RawAggregationFilter.eval(_, typesCache, cmwellRDFHelper, timeContext))
            val fieldsFiltersFut = qpOpt.fold(Future.successful(Option.empty[FieldFilter]))(
              rff => RawFieldFilter.eval(rff, typesCache, cmwellRDFHelper, timeContext).map(Some.apply)
            )
            fieldsFiltersFut
              .transformWith {
                case Failure(err) => {
                  val msg = s"failed to evaluate given qp [${qpOpt.fold("")(_.toString)}]"
                  logger.error(msg, err)
                  val res = FailedDependency(Json.obj("success" -> false, "message" -> msg))
                  request.attrs.get(Attrs.RequestReceivedTimestamp).fold(Future.successful(res)) { reqStartTime =>
                    val timePassedInMillis = System.currentTimeMillis() - reqStartTime
                    if (timePassedInMillis > 9000L) Future.successful(res)
                    else SimpleScheduler.schedule((9500L - timePassedInMillis).millis)(res)
                  }
                }
                case Success(fieldFilters) => {
                  apfut.flatMap { af =>
                    crudServiceFS
                      .aggregate(pathFilter,
                                 fieldFilters,
                                 Some(DatesFilter(from, to)),
                                 PaginationParams(offset, length),
                                 withHistory,
                                 af.flatten,
                                 debugInfo)
                      .map { aggResult =>
                        request.getQueryString("format").getOrElse("json") match {
                          case FormatExtractor(formatType) => {
                            val formatter = formatterManager.getFormatter(
                              format = formatType,
                              timeContext = timeContext,
                              host = request.host,
                              uri = request.uri,
                              pretty = request.queryString.keySet("pretty"),
                              callback = request.queryString.get("callback").flatMap(_.headOption)
                            )
                            Ok(formatter.render(aggResult)).as(overrideMimetype(formatter.mimetype, request)._2)
                          }
                          case unrecognized: String => BadRequest(s"unrecognized format requested: $unrecognized")
                        }
                      }
                  }
                }
              }
              .recover(translateAggregateException.andThen(errorHandler))
          case Failure(e) => asyncErrorHandler(e)
        }
      }
      .recover(asyncErrorHandler)
      .get

  private[this] def translateAggregateException: PartialFunction[Throwable, Throwable] = {
    case e: org.elasticsearch.transport.RemoteTransportException
        if e.getCause.isInstanceOf[org.elasticsearch.action.search.SearchPhaseExecutionException]
          && e.getCause.getMessage.contains("cannot be cast to org.elasticsearch.index.fielddata.IndexNumericFieldData") =>
      new BadFieldTypeException(
        "Cannot cast field to numeric value. Did you try to use stats or histogram aggregations on non numeric field?", e)
    case e:IllegalArgumentException
      if e.getMessage.contains("aggregations failure due to text system field")
    => new IllegalArgumentException("Stats API is not supported for text system fields.", e)
    case e:IllegalArgumentException if e.getMessage.contains("aggregations failure due to fielddata disabled")
      => new IllegalArgumentException("Stats API does not support non-exact value operator for text fields. Please use :: instead of :", e)
    case e => e
  }

  private def handleSearch(r: Request[AnyContent]): Future[Result] =
    handleSearch(normalizePath(r.path), cmWellBase(r), r.host, r.uri, r.attrs.get(Attrs.RequestReceivedTimestamp))(
      r.queryString
    )

  private def handleSearch(
    normalizedPath: String,
    cmWellBase: String,
    requestHost: String,
    requestUri: String,
    requestReceivedTimestamp: Option[Long]
  )(implicit queryString: Map[String, Seq[String]]): Future[Result] =
    getQueryString("qp")
      .fold(Success(None): Try[Option[RawFieldFilter]])(FieldFilterParser.parseQueryParams(_).map(Some.apply))
      .map { qpOpt =>
        val from = DateParser.parseDate(getQueryString("from").getOrElse(""), FromDate).toOption
        val to = DateParser.parseDate(getQueryString("to").getOrElse(""), ToDate).toOption
        val length = getQueryString("length").flatMap(asInt).getOrElse(10)
        val offset = getQueryString("offset").flatMap(asInt).getOrElse(0)
        val withDataFormat = getQueryString("with-data")
        val withData = withDataFormat.isDefined && withDataFormat.get.toLowerCase != "false"
        //FIXME: `getOrElse` swallows parsing errors that should come out as `BadRequest`
        val rawSortParams =
          getQueryString("sort-by").flatMap(SortByParser.parseFieldSortParams(_).toOption).getOrElse(RawSortParam.empty)
        val withDescendants = queryString.keySet("with-descendants") || queryString.keySet("recursive")
        val withDeleted = queryString.keySet("with-deleted")
        val pathFilter = Some(PathFilter(normalizedPath, withDescendants))
        val withHistory = queryString.keySet("with-history")
        val debugInfo = queryString.keySet("debug-info")
        val gqp = queryString.keySet("gqp")
        val xg = queryString.keySet("xg")
        val yg = queryString.keySet("yg")

        if (offset > Settings.maxOffset) {
          Future.successful(BadRequest(s"Even Google doesn't handle offsets larger than ${Settings.maxOffset}!"))
        } else if (length > Settings.maxLength) {
          Future.successful(BadRequest(s"Length is larger than ${Settings.maxLength}!"))
        } else if (withHistory && (xg || yg || gqp))
          Future.successful(BadRequest(s"you can't mix `xg` nor `yg` with `with-history`: it makes no sense!"))
        else if (!withData && (xg || (yg && getQueryString("yg").get.trim.startsWith(">")) || (gqp && getQueryString(
                   "gqp"
                 ).get.trim.startsWith(">"))))
          Future.successful(
            BadRequest(
              s"you can't mix `xg` nor '>' prefixed `yg`/`gqp` expressions without also specifying `with-data`: it makes no sense!"
            )
          )
        else {
          val fieldSortParamsFut =
            RawSortParam.eval(rawSortParams, crudServiceFS, typesCache, cmwellRDFHelper, requestReceivedTimestamp)
          val fieldsFiltersFut = qpOpt.fold[Future[Option[FieldFilter]]](Future.successful(Option.empty[FieldFilter]))(
            rff => RawFieldFilter.eval(rff, typesCache, cmwellRDFHelper, requestReceivedTimestamp).map(Some.apply)
          )
          fieldsFiltersFut
            .transformWith {
              case Failure(err) => {
                val msg = s"failed to evaluate given qp [${qpOpt.fold("")(_.toString)}]"
                logger.error(msg, err)
                val res = FailedDependency(Json.obj("success" -> false, "message" -> msg))
                requestReceivedTimestamp.fold(Future.successful(res)) { reqStartTime =>
                  val timePassedInMillis = System.currentTimeMillis() - reqStartTime
                  if (timePassedInMillis > 9000L) Future.successful(res)
                  else SimpleScheduler.schedule((9500L - timePassedInMillis).millis)(res)
                }
              }
              case Success(fieldFilters) =>
                fieldSortParamsFut.flatMap { fieldSortParams =>
                  crudServiceFS
                    .search(pathFilter,
                            fieldFilters,
                            Some(DatesFilter(from, to)),
                            PaginationParams(offset, length),
                            withHistory,
                            withData,
                            fieldSortParams,
                            debugInfo,
                            withDeleted)
                    .flatMap { unmodifiedSearchResult =>
                      val gqpModified = getQueryString("gqp").fold(Future.successful(unmodifiedSearchResult.infotons)) {
                        gqpPattern =>
                          gqpFilter(
                            gqpPattern,
                            unmodifiedSearchResult.infotons,
                            cmwellRDFHelper,
                            typesCache,
                            getQueryString("gqp-chunk-size").flatMap(asInt).getOrElse(10),
                            requestReceivedTimestamp
                          )
                      }

                      val ygModified = getQueryString("yg") match {
                        case Some(ygp) =>
                          gqpModified.flatMap { gqpFilteredInfotons =>
                            pathExpansionParser(ygp,
                                                gqpFilteredInfotons,
                                                getQueryString("yg-chunk-size").flatMap(asInt).getOrElse(10),
                                                cmwellRDFHelper,
                                                typesCache,
                                                requestReceivedTimestamp).map {
                              case (ok, infotons) =>
                                ok -> unmodifiedSearchResult.copy(
                                  length = infotons.size,
                                  infotons = infotons
                                )
                            }
                          }
                        case None =>
                          gqpModified.map { gqpFilteredInfotons =>
                            if (!gqp) true -> unmodifiedSearchResult
                            else
                              true -> unmodifiedSearchResult.copy(
                                length = gqpFilteredInfotons.length,
                                infotons = gqpFilteredInfotons
                              )
                          }
                      }

                      val fSearchResult = ygModified.flatMap {
                        case (true, sr) =>
                          getQueryString("xg") match {
                            case None => Future.successful(true -> sr)
                            case Some(xgp) => {
                              deepExpandGraph(xgp, sr.infotons, cmwellRDFHelper, typesCache, requestReceivedTimestamp)
                                .map {
                                  case (ok, infotons) =>
                                    ok -> unmodifiedSearchResult.copy(
                                      length = infotons.size,
                                      infotons = infotons
                                    )
                                }
                            }
                          }
                        case (b, sr) => Future.successful(b -> sr)
                      }

                      fSearchResult.flatMap {
                        case (ok, searchResult) =>
                          extractFieldsMask(getQueryString("fields"),
                                            typesCache,
                                            cmwellRDFHelper,
                                            requestReceivedTimestamp).map { fieldsMask =>
                            // Prepare pagination info
                            val searchUrl = cmWellBase + normalizedPath + "?op=search"
                            val format = getQueryString("format").fold("")("&format=".+)
                            val descendants = getQueryString("with-descendants").fold("")("&with-descendants=".+)
                            val recursive = getQueryString("recursive").fold("")("&recursive=".+)

                            val from = searchResult.fromDate.fold("")(
                              f => "&from=" + URLEncoder.encode(fullDateFormatter.print(f), "UTF-8")
                            )
                            val to = searchResult.toDate.fold("")(
                              t => "&to=" + URLEncoder.encode(fullDateFormatter.print(t), "UTF-8")
                            )

                            val qp = getQueryString("qp").fold("")("&qp=" + URLEncoder.encode(_, "UTF-8"))

                            val lengthParam = "&length=" + searchResult.length

                            val linkBase = searchUrl + format + descendants + recursive + from + to + qp + lengthParam
                            val self = linkBase + "&offset=" + searchResult.offset
                            val first = linkBase + "&offset=0"
                            val last = searchResult.length match {
                              case l if l > 0 =>
                                linkBase + "&offset=" + ((searchResult.total / searchResult.length) * searchResult.length)
                              case _ => linkBase + "&offset=0"
                            }

                            val next = searchResult.offset + searchResult.length - searchResult.total match {
                              case x if x < 0 =>
                                Some(linkBase + "&offset=" + (searchResult.offset + searchResult.length))
                              case _ => None
                            }

                            val previous = (searchResult.offset - searchResult.length) match {
                              case dif if dif >= 0                              => Some(linkBase + "&offset=" + dif)
                              case dif if dif < 0 && -dif < searchResult.length => Some(linkBase + "&offset=0")
                              case _                                            => None
                            }

                            val paginationInfo = PaginationInfo(first, previous, self, next, last)

                            //TODO: why not check for valid format before doing all the hard work for search?
                            getQueryString("format").getOrElse("atom") match {
                              case FormatExtractor(formatType) => {
                                val formatter = formatterManager.getFormatter(
                                  format = formatType,
                                  timeContext = requestReceivedTimestamp,
                                  host = requestHost,
                                  uri = requestUri,
                                  pretty = queryString.keySet("pretty"),
                                  callback = queryString.get("callback").flatMap(_.headOption),
                                  fieldFilters = fieldFilters,
                                  offset = Some(offset.toLong),
                                  length = Some(length.toLong),
                                  withData = withDataFormat,
                                  forceUniqueness = withHistory
                                )
                                if (ok)
                                  Ok(formatter.render(SearchResponse(paginationInfo, searchResult.masked(fieldsMask))))
                                    .as(overrideMimetype(formatter.mimetype, getQueryString("override-mimetype"))._2)
                                else
                                  InsufficientStorage(formatter.render(SearchResponse(paginationInfo, searchResult)))
                                    .as(overrideMimetype(formatter.mimetype, getQueryString("override-mimetype"))._2)
                              }
                              case unrecognized: String => BadRequest(s"unrecognized format requested: $unrecognized")
                            }
                          }
                      }
                    }
                }
            }
            .recover(errorHandler)
        }
      }
      .recover(asyncErrorHandler)
      .get

  private def handleRead(request: Request[AnyContent], recursiveCalls: Int = 30): Future[Result] =
    Try {
      val length = request.getQueryString("length").flatMap(asInt).getOrElse(0)
      val offset = request.getQueryString("offset").flatMap(asInt).getOrElse(0)
      val format = request.getQueryString("format")
      val path = normalizePath(request.path)
      val xg = request.getQueryString("xg")
      val (yg, ygChunkSize) = request
        .getQueryString("yg")
        .fold(Option.empty[String] -> 0)(
          Some(_) -> request.getQueryString("yg-chunk-size").flatMap(asInt).getOrElse(10)
        )
      val withHistory = request.queryString.keySet("with-history")
      val limit =
        request.getQueryString("versions-limit").flatMap(asInt).getOrElse(Settings.defaultLimitForHistoryVersions)
      val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)
      val serviceOpt = servicesRoutesCache.find(path)

      if (offset > Settings.maxOffset) {
        Future.successful(BadRequest(s"Even Google doesn't handle offsets larger than ${Settings.maxOffset}!"))
      } else if (length > Settings.maxLength) {
        Future.successful(BadRequest(s"Length is larger than ${Settings.maxOffset}!"))
      } else if (Set("/meta/ns/sys", "/meta/ns/nn")(path)) {
        handleGetForActiveInfoton(request, path)
      } else if (serviceOpt.isDefined) {
        serviceOpt.get match {
          case redirection: RedirectionService if recursiveCalls > 0 =>
            val to = redirection.replaceFunc(path)
            recurseRead(request, to, recursiveCalls - 1)
          case _: RedirectionService => Future.successful(BadRequest("too deep redirection service chain detected!"))
          case _ => ???
        }
      } else {
        val reply = {
          if (withHistory && (xg.isDefined || yg.isDefined))
            Future.successful(BadRequest(s"you can't mix `xg` nor `yg` with `with-history`: it makes no sense!"))
          else if (withHistory) {
            if (isReactive(request)) {
              format.getOrElse("json") match {
                case f
                    if !Set("text", "path", "tsv", "tab", "nt", "ntriples", "nq", "nquads")(f.toLowerCase) && !f.toLowerCase
                      .startsWith("json") =>
                  Future.successful(
                    BadRequest(
                      Json.obj(
                        "success" -> false,
                        "message" -> "not a streamable type (use any json, or one of: 'text','tsv','ntriples', or 'nquads')"
                      )
                    )
                  )
                case FormatExtractor(formatType) => {
                  val formatter = formatterManager.getFormatter(
                    format = formatType,
                    timeContext = timeContext,
                    host = request.host,
                    uri = request.uri,
                    pretty = false,
                    callback = request.queryString.get("callback").flatMap(_.headOption),
                    withoutMeta = !request.queryString.keySet("with-meta"),
                    filterOutBlanks = true,
                    forceUniqueness = true
                  )

                  val infotonsSource = crudServiceFS.getInfotonHistoryReactive(path)

                  val f: Formattable => ByteString = formattableToByteString(formatter)
                  val bytes = infotonsSource.map(f.andThen {
                    _.toArray
                  })

                  Future.successful(Ok.chunked(bytes).as(overrideMimetype(formatter.mimetype, request)._2))
                }
              }
            } else {
              val formatter = format.getOrElse("atom") match {
                case FormatExtractor(formatType) =>
                  formatterManager.getFormatter(
                    format = formatType,
                    timeContext = timeContext,
                    host = request.host,
                    uri = request.uri,
                    pretty = request.queryString.keySet("pretty"),
                    callback = request.queryString.get("callback").flatMap(_.headOption),
                    withData = request.getQueryString("with-data")
                  )
              }

              crudServiceFS
                .getInfotonHistory(path, limit)
                .map(ihv => Ok(formatter.render(ihv)).as(overrideMimetype(formatter.mimetype, request)._2))
            }
          } else {
            lazy val formatter = format.getOrElse("json") match {
              case FormatExtractor(formatType) =>
                formatterManager.getFormatter(
                  formatType,
                  timeContext = timeContext,
                  request.host,
                  request.uri,
                  request.queryString.keySet("pretty"),
                  request.queryString.keySet("raw"),
                  request.queryString.get("callback").flatMap(_.headOption)
                )
              case unknown => {
                logger.warn(s"got unknown format: $unknown")
                formatterManager.prettyJsonFormatter
              }
            }

            crudServiceFS.getInfoton(path, Some(offset), Some(length)).flatMap {
              case Some(UnknownNestedContent(i)) =>
                //TODO: should still allow xg expansion?
                Future.successful(
                  PartialContent(formatter.render(i)).as(overrideMimetype(formatter.mimetype, request)._2)
                )
              case infopt => {
                val i = infopt.fold(GhostInfoton.ghost(path, "http")) {
                  case Everything(j)           => j
                  case _: UnknownNestedContent => !!!
                }
                extractFieldsMask(request, typesCache, cmwellRDFHelper, timeContext).flatMap { fieldsMask =>
                  val toRes = (f: Future[(Boolean, Seq[Infoton])]) =>
                    f.map {
                      case ((true, xs)) =>
                        Ok(formatter.render(BagOfInfotons(xs))).as(overrideMimetype(formatter.mimetype, request)._2)
                      case ((false, xs)) =>
                        InsufficientStorage(formatter.render(BagOfInfotons(xs)))
                          .as(overrideMimetype(formatter.mimetype, request)._2)
                  }
                  val ygFuncOpt = yg.map(
                    ygPattern =>
                      (iSeq: Seq[Infoton]) =>
                        pathExpansionParser(ygPattern, iSeq, ygChunkSize, cmwellRDFHelper, typesCache, timeContext)
                  )
                  val xgFuncOpt = xg.map(
                    xgPattern =>
                      (iSeq: Seq[Infoton]) => deepExpandGraph(xgPattern, iSeq, cmwellRDFHelper, typesCache, timeContext)
                  )
                  val xygFuncOpt = ygFuncOpt.flatMap(
                    ygFunc =>
                      xgFuncOpt.map(
                        xgFunc =>
                          (iSeq: Seq[Infoton]) =>
                            ygFunc(iSeq).flatMap {
                              case (true, jSeq) => xgFunc(jSeq)
                              case t            => Future.successful(t)
                        }
                    )
                  )

                  if (infopt.isEmpty && yg.isEmpty) infotonOptionToReply(request, None, recursiveCalls)
                  else
                    xygFuncOpt
                      .map(_.andThen(toRes))
                      .map(_(Seq(i)))
                      .getOrElse(
                        ygFuncOpt
                          .map(_.andThen(toRes))
                          .map(_(Seq(i)))
                          .getOrElse(
                            xgFuncOpt
                              .map(_.andThen(toRes))
                              .map(_(Seq(i)))
                              .getOrElse(infotonOptionToReply(request, Some(i), recursiveCalls, fieldsMask))
                          )
                      )
                }
              }
            }
          }
        }
        reply.recover(errorHandler)
      }
    }.recover(asyncErrorHandler).get

  def infotonOptionToReply(request: Request[AnyContent],
                           infoton: Option[Infoton],
                           recursiveCalls: Int = 30,
                           fieldsMask: Set[String] = Set.empty): Future[Result] =
    Try {
      val offset = request.getQueryString("offset")
      val timeContext = request.attrs.get(Attrs.RequestReceivedTimestamp)
      (if (offset.isEmpty) actions.ActiveInfotonHandler.wrapInfotonReply(infoton) else infoton) match {
        case None => Future.successful(NotFound("Infoton not found"))
        case Some(DeletedInfoton(systemFields)) =>
          Future.successful(NotFound(s"Infoton was deleted on ${fullDateFormatter.print(systemFields.lastModified)}"))
        case Some(LinkInfoton(_, _, to, lType)) =>
          lType match {
            case LinkType.Permanent => Future.successful(Redirect(to, request.queryString, MOVED_PERMANENTLY))
            case LinkType.Temporary => Future.successful(Redirect(to, request.queryString, TEMPORARY_REDIRECT))
            case LinkType.Forward if recursiveCalls > 0 => recurseRead(request, to, recursiveCalls - 1)
            case LinkType.Forward => Future.successful(BadRequest("too deep forward link chain detected!"))
          }
        case Some(i) =>
          val maskedInfoton = i.masked(fieldsMask)

          //TODO: use formatter manager to get the suitable formatter
          request.getQueryString("format") match {
            case Some(FormatExtractor(formatType)) => {
              val formatter = formatterManager.getFormatter(
                format = formatType,
                timeContext = timeContext,
                host = request.host,
                uri = request.uri,
                pretty = request.queryString.keySet("pretty"),
                callback = request.getQueryString("callback"),
                offset = request.getQueryString("offset").map(_.toInt),
                length = request.getQueryString("length").map(_.toInt)
              )

              Future.successful(
                Ok(formatter.render(maskedInfoton)).as(overrideMimetype(formatter.mimetype, request)._2)
              )
            }
            // default format
            case _ =>
              i match {
                case f: FileInfoton if request.headers.get("x-compile-to").contains("js") =>
                  val scalaJsSource = new String(f.content.get.data.get, "UTF-8")
                  val mime = "application/javascript"
                  ScalaJsRuntimeCompiler
                    .compile(scalaJsSource)
                    .flatMap(
                      c => treatContentAsAsset(request, c.getBytes("UTF-8"), mime, i.systemFields.path, i.uuid, i.systemFields.lastModified)
                    )
                case f: FileInfoton => {
                  val mt = f.content.get.mimeType
                  val (content, mime) = {
                    if (isMarkdown(mt) && !request.queryString.keySet("raw")) {
                      (MarkdownFormatter.asHtmlString(f).getBytes, "text/html")
                    } else (f.content.get.data.get, mt)
                  }
                  treatContentAsAsset(request, content, mime, i.systemFields.path, i.uuid, i.systemFields.lastModified)
                }
                case c: CompoundInfoton if c.children.exists(_.systemFields.name.equalsIgnoreCase("index.html")) =>
                  Future.successful(Redirect(routes.Application.handleGET(s"${c.systemFields.path}/index.html".substring(1))))
                // ui
                case _ => {
                  val params = {
                    val webapp = if (request.queryString.keySet("old-ui")) "webapp=angular"
                                 else request.getQueryString("webapp").fold("")(wa => s"webapp=$wa")
                    val remember = if (request.queryString.keySet("remember")) "remember" else ""
                    val path = s"""path=${request.getQueryString("path").orElse(infoton.map(_.systemFields.path)).getOrElse("")}"""
                    val all = Seq(webapp, remember, path).filterNot(_.isEmpty).mkString("&")
                    if(all.isEmpty) "" else s"?$all"
                  }
                  Future.successful(Redirect(routes.Application.handleGET(s"meta/app/boot.html$params"))) // 🚀
                }
              }
          }
      }
    }.recover(asyncErrorHandler).get


    def recurseRead(request: Request[AnyContent], newPath: String, recursiveCalls: Int) = handleRead(
      request.withTarget(RequestTarget(
        uriString = newPath + request.uri.drop(request.path.length),
        path = newPath,
        queryString = request.queryString)
        ).withBody(request.body),
      recursiveCalls - 1
    )

  def isMarkdown(mime: String): Boolean =
    mime.startsWith("text/x-markdown") || mime.startsWith("text/vnd.daringfireball.markdown")

  def boolFutureToRespones(fb: Future[Boolean]) = fb.map {
    case true  => successResponse
    case false => BadRequest(Json.obj("success" -> false))
  }

  def handlePutInfoton(path: String): Request[RawBuffer] => Future[Result] = { implicit originalRequest =>
    requestSlashValidator(originalRequest)
      .map { request =>
        val normalizedPath = normalizePath(request.path)
        val isPriorityWrite = originalRequest.getQueryString("priority").isDefined
        val modifier = request.attrs(Attrs.UserName)

        if (!InfotonValidator.isInfotonNameValid(normalizedPath)) {
          Future.successful(
            BadRequest(
              Json.obj(
                "success" -> false,
                "message" -> """you can't write to "meta" / "proc" / "ii" / or any path starting with "_" (service paths...)"""
              )
            )
          )
        } else if (isPriorityWrite && !authUtils.isOperationAllowedForUser(security.PriorityWrite,
                                                                           authUtils.extractTokenFrom(originalRequest),
                                                                           evenForNonProdEnv = true)) {
          Future.successful(
            Forbidden(Json.obj("success" -> false, "message" -> "User not authorized for priority write"))
          )
        } else
          request match {
            case XCmWellType.Object() => {
              val bodyBytes = request.body.asBytes().fold(Array.emptyByteArray)(_.toArray[Byte])
              jsonToFields(bodyBytes) match {
                case Success(fields) =>
                  InfotonValidator.validateValueSize(fields)
                  boolFutureToRespones(
                    crudServiceFS.putInfoton(ObjectInfoton(SystemFields(normalizedPath, new DateTime(DateTimeZone.UTC), modifier, Settings.dataCenter, None, "",
                      "http"), fields), isPriorityWrite)
                  )
                // TODO handle validation
                case Failure(exception) => asyncErrorHandler(exception)
              }
            }
            case XCmWellType.File() => {
              val content = request.body.asBytes().fold(Array.emptyByteArray)(_.toArray[Byte])
              if (content.isEmpty)
                Future.successful(BadRequest(Json.obj("success" -> false, "cause" -> "empty content")))
              else {
                val contentType = request.headers
                  .get("Content-Type")
                  .orElse(
                    MimeTypeIdentifier
                      .identify(content, normalizedPath.slice(normalizedPath.lastIndexOf("/"), normalizedPath.length))
                  )
                  .getOrElse("text/plain")
                boolFutureToRespones(
                  crudServiceFS.putInfoton(FileInfoton(SystemFields(path = normalizedPath, new DateTime(DateTimeZone.UTC), lastModifiedBy = modifier,
                      dc = Settings.dataCenter, None, "", "http"), content = Some(FileContent(content, contentType))), isPriorityWrite)
                )
              }
            }
            case XCmWellType.FileMD() => {
              val bodyBytes = request.body.asBytes().fold(Array.emptyByteArray)(_.toArray[Byte])
              jsonToFields(bodyBytes) match {
                case Success(fields) =>
                  InfotonValidator.validateValueSize(fields)
                  boolFutureToRespones(
                    crudServiceFS
                      .putInfoton(FileInfoton(SystemFields(normalizedPath, new DateTime(DateTimeZone.UTC), modifier, Settings.dataCenter, None, "", "http"),
                        fields = Some(fields)), isPriorityWrite)
                    )
                case Failure(exception) =>
                  Future.successful(BadRequest(Json.obj("success" -> false, "cause" -> exception.getMessage)))
              }
            }
            case XCmWellType.Link() => {
              val linkTo = request.body.asBytes().fold("")(_.utf8String)
              val linkTypeStr = request.headers.get("X-CM-WELL-LINK-TYPE").getOrElse("1")
              val linkType = linkTypeStr match {
                case "0" => LinkType.Permanent
                case "1" => LinkType.Temporary
                case "2" => LinkType.Forward
              }
              boolFutureToRespones(
                crudServiceFS.putInfoton(LinkInfoton(SystemFields(normalizedPath, new DateTime(DateTimeZone.UTC), modifier, Settings.dataCenter, None, "",
                  "http"), fields = Some(Map[String, Set[FieldValue]]()), linkTo = linkTo, linkType = linkType),
                  isPriorityWrite)
              )
            }
            case _ => Future.successful(BadRequest(Json.obj("success" -> false, "cause" -> "unrecognized type")))
          }
      }
      .recover(asyncErrorHandler)
      .get
  }

  private def jsonToFields(jsonBytes: Array[Byte]): Try[Map[String, Set[FieldValue]]] = {

    Try(Json.parse(jsonBytes))
      .flatMap {
        case JsObject(fields) =>
          val data: MultiMap[String, FieldValue] = new HashMap[String, collection.mutable.Set[FieldValue]]()
          with MultiMap[String, FieldValue]
          fields.foreach {
            case (k, JsString(s))  => data.addBinding(k, FString(s))
            case (k, JsNumber(n))  => data.addBinding(k, Encoders.numToFieldValue(n))
            case (k, JsBoolean(b)) => data.addBinding(k, FString("" + b))
            case (k, JsArray(arr)) =>
              arr.foreach {
                case (JsString(s))  => data.addBinding(k, FString(s))
                case (JsNumber(n))  => data.addBinding(k, Encoders.numToFieldValue(n))
                case (JsBoolean(b)) => data.addBinding(k, FString("" + b))
                case _              =>
              }
            case _ => Failure(new IllegalArgumentException("Json depth level allowed is 1"))
          }
          Success(data.map { case (x, y) => (x, y.toSet) }.toMap)
        case _ => Failure(new IllegalArgumentException("Json value must be an object"))
      }
      .recoverWith {
        case parseException =>
          Failure(new IllegalArgumentException("Request body is not a recognized json", parseException))
      }
  }

  def handleAuthGet() = Action.async { req =>
    req.getQueryString("op") match {
      case Some("generate-password") => {
        val pw = authUtils.generateRandomPassword()
        Future.successful(Ok(Json.obj(("password", JsString(pw._1)), ("encrypted", pw._2))))
      }
      case Some("change-password") => {
        val currentPassword = req.getQueryString("current")
        val newPassword = req.getQueryString("new")
        val token = authUtils.extractTokenFrom(req)

        if (Seq(currentPassword, newPassword, token).forall(_.isDefined)) {
          authUtils.changePassword(token.get, currentPassword.get, newPassword.get).map {
            case true => Ok(Json.obj("success" -> true))
            case _ =>
              Forbidden(Json.obj("success" -> false, "message" -> "Current password does not match given token"))
          }
        } else {
          Future.successful(BadRequest(Json.obj("success" -> false, "message" -> "insufficient arguments")))
        }
      }
      case Some("invalidate-cache") => {
        if (isAdminEvenNonProd(req))
          authUtils.invalidateAuthCache().map(isSuccess => Ok(Json.obj("success" -> isSuccess)))
        else
          Future.successful(Unauthorized("Not authorized"))
      }
      case Some(unknownOp) =>
        Future.successful(
          BadRequest(Json.obj("success" -> false, "message" -> s"`$unknownOp` is not a valid operation"))
        )
      case None =>
        Future.successful(BadRequest(Json.obj("success" -> false, "message" -> "`op` query parameter was expected")))
    }
  }

  val endlnBytes: Array[Byte] = "\n".getBytes("UTF-8")
  val emptyBytes: Array[Byte] = Array.empty[Byte]

  def handleFix(req: Request[AnyContent]): Future[Result] = {
    if (!authUtils.isOperationAllowedForUser(security.Overwrite, authUtils.extractTokenFrom(req)))
      Future.successful(Forbidden("not authorized to overwrite"))
    else if (isReactive(req)) {
      val formatter = getFormatter(req, formatterManager, "json")
      val parallelism = req.getQueryString("parallelism").flatMap(asInt).getOrElse(1)
      crudServiceFS.rFix(normalizePath(req.path), parallelism).map { source =>
        val s = source
          .map { bs =>
            val msg = if (bs._2.isEmpty) None else Some(bs._2)
            ByteString(formatter.render(SimpleResponse(bs._1, msg)), StandardCharsets.UTF_8)
          }
          .intersperse(ByteString.empty, Streams.endln, Streams.endln)
        Ok.chunked(s)
      }
    } else {
      val limit = req.getQueryString("versions-limit").flatMap(asInt).getOrElse(Settings.defaultLimitForHistoryVersions)
      val f = crudServiceFS.fix(normalizePath(req.path), limit)
      val formatter = getFormatter(req, formatterManager, "json")
      val r = f.map { bs =>
        Ok(formatter.render(SimpleResponse(bs._1, if (bs._2.isEmpty) None else Some(bs._2))))
          .as(overrideMimetype(formatter.mimetype, req)._2)
      }
      keepAliveByDrippingNewlines(r)
    }
  }

  def handleVerify(req: Request[AnyContent]): Future[Result] = {
    val limit = req.getQueryString("versions-limit").flatMap(asInt).getOrElse(Settings.defaultLimitForHistoryVersions)
    val f = crudServiceFS.verify(normalizePath(req.path), limit)
    val formatter = getFormatter(req, formatterManager, "json")
    f.map { b =>
      Ok(formatter.render(SimpleResponse(b, None))).as(overrideMimetype(formatter.mimetype, req)._2)
    }
  }

  def handleInfo(req: Request[AnyContent]): Future[Result] = {
    val path = normalizePath(req.path)
    val limit = req.getQueryString("versions-limit").flatMap(asInt).getOrElse(Settings.defaultLimitForHistoryVersions)
    crudServiceFS
      .info(path, limit)
      .map {
        case (cas, es, zs) => {
          val c = cas.map {
            case (u, io) => s"cas $u ${io.map(i => formatterManager.jsonFormatter.render(i)).getOrElse("none")}"
          }
          val e = es.groupBy(_._1).map {
            case (uuid, tuples) =>
              val (indices, sources) = tuples.unzip {
                case (_, index, version, source) =>
                  s"$index($version)" -> source
              }
              val start = s"es  $uuid ${indices.mkString("[", ",", "]")} "
              val head = start + sources.head
              if (sources.size == 1) head
              else {
                val spaces = " " * start.length
                head + sources.mkString("\n" + spaces)
              }
          }
          val z = zs.map("zs  ".+)
          val body = (c ++ e ++ z).sortBy(_.drop(4)).mkString("\n")
          Ok(body).as(overrideMimetype("text/plain;charset=UTF8", req)._2)
        }
      }
      .recover {
        case e: Throwable => {
          logger.error("x-info future failed", e)
          InternalServerError(e.getMessage)
        }
      }
  }

  def handlePurgeAll(req: Request[AnyContent]) = handlePurge(req, includeLast = true)

  def handlePurgeHistory(req: Request[AnyContent]) = handlePurge(req, includeLast = false)

  def handlePurgeLast(req: Request[AnyContent]) = handlePurge(req, includeLast = true, onlyLast = true)

  private def handlePurge(req: Request[AnyContent], includeLast: Boolean, onlyLast: Boolean = false): Future[Result] = {
    if (req.getQueryString("2").isDefined) handlePurge2(req)
    else {

      lazy val notImplemented =
        Future.failed(new NotImplementedError("This specific version of CM-Well does not support this operation."))

      val p = Promise[Result]()

      val path = normalizePath(req.path)
      val allowed =
        authUtils.filterNotAllowedPaths(Seq(path), PermissionLevel.Write, authUtils.extractTokenFrom(req)).isEmpty
      if (!allowed) {
        p.completeWith(Future.successful(Forbidden("Not authorized")))
      } else if (path == "/") {
        p.completeWith(Future.successful(BadRequest("Purging Root Infoton does not make sense!")))
      } else {
        val formatter = getFormatter(req, formatterManager, "json")
        val limit =
          req.getQueryString("versions-limit").flatMap(asInt).getOrElse(Settings.defaultLimitForHistoryVersions)
        val res =
          if (onlyLast)
            notImplemented // CRUDServiceFS.rollback(path,limit)
          else if (includeLast) crudServiceFS.purgePath(path, includeLast, limit)
          else notImplemented // CRUDServiceFS.purgePath(path, includeLast, limit)

        res.onComplete {
          case Success(_) =>
            p.completeWith(
              Future.successful(
                Ok(formatter.render(SimpleResponse(true, None))).as(overrideMimetype(formatter.mimetype, req)._2)
              )
            )
          case Failure(e) =>
            p.completeWith(
              Future.successful(
                Ok(formatter.render(SimpleResponse(false, Option(e.getCause.getMessage))))
                  .as(overrideMimetype(formatter.mimetype, req)._2)
              )
            )
        }
      }

      p.future
    }
  }

  private def handlePurge2(req: Request[AnyContent]): Future[Result] = {
    val path = normalizePath(req.path)
    val allowed =
      authUtils.filterNotAllowedPaths(Seq(path), PermissionLevel.Write, authUtils.extractTokenFrom(req)).isEmpty
    if (!allowed) {
      Future.successful(Forbidden("Not authorized"))
    } else {
      val formatter = getFormatter(req, formatterManager, "json")
      val limit = req.getQueryString("versions-limit").flatMap(asInt).getOrElse(Settings.defaultLimitForHistoryVersions)
      crudServiceFS.purgePath2(path, limit).map { b =>
        Ok(formatter.render(SimpleResponse(true, None))).as(overrideMimetype(formatter.mimetype, req)._2)
      }
    }
  }

  def handleRawDoc(uuid: String) = Action.async { req =>
    crudServiceFS
      .getInfotonByUuidAsync(uuid)
      .flatMap {
        case FullBox(i) => {
          val index = i.systemFields.indexName
          val a = handleRawDocWithIndex(index, uuid)
          a(req)
        }
        case BoxedFailure(ex) => logger.error(s"Unexpected result: Boxed Failiure with exception:", ex) ; throw ex
        case EmptyBox => logger.error(s"Unexpected result: Empty Boxed") ; ???
      }
      .recoverWith {
        case err: Throwable => {
          logger.error(s"could not retrive uuid[$uuid] from cassandra", err)
          crudServiceFS.ftsService.uinfo(uuid).map { vec =>
            val jArr = vec.map {
              case (index, version, source) =>
                Json.obj("_index" -> index, "_version" -> JsNumber(version), "_source" -> Json.parse(source))
            }

            val j = {
              if (jArr.length < 2) jArr.headOption.getOrElse(JsNull)
              else Json.arr(jArr)
            }
            val pretty = req.queryString.keySet("pretty")
            val payload = {
              if (pretty) Json.prettyPrint(j)
              else Json.stringify(j)
            }
            Ok(payload).as(overrideMimetype("application/json;charset=UTF-8", req)._2)
          }
        }
      }
      .recoverWith(asyncErrorHandler)
  }

  def handleRawDocWithIndex(index: String, uuid: String) = Action.async { req =>
    crudServiceFS.ftsService
      .extractSource(uuid, index)
      .map {
        case (source, version) =>
          val j = Json.obj("_index" -> index, "_version" -> JsNumber(version), "_source" -> Json.parse(source))
          val pretty = req.queryString.keySet("pretty")
          val payload = {
            if (pretty) Json.prettyPrint(j)
            else Json.stringify(j)
          }
          Ok(payload).as(overrideMimetype("application/json;charset=UTF-8", req)._2)
      }
      .recoverWith(asyncErrorHandler)
  }

  def handleRawRow(path: String) = Action.async { req =>
    val limit = req.getQueryString("versions-limit").flatMap(asInt).getOrElse(Settings.defaultLimitForHistoryVersions)
    path match {
      case Uuid(uuid) =>
        handleRawUUID(uuid, isReactive(req), limit) { defaultMimetype =>
          overrideMimetype(defaultMimetype, req)._2
        }.recoverWith(asyncErrorHandler)
      case _ => {
        handleRawPath("/" + path, isReactive(req), limit) { defaultMimetype =>
          overrideMimetype(defaultMimetype, req)._2
        }.recoverWith(asyncErrorHandler)
      }
    }
  }

  def handleRawUUID(uuid: String, isReactive: Boolean, limit: Int)(
    defaultMimetypeToReturnedMimetype: String => String
  ) = {
    if (isReactive) {
      val src = crudServiceFS.reactiveRawCassandra(uuid).intersperse("\n").map(ByteString(_, StandardCharsets.UTF_8))
      Future.successful(Ok.chunked(src).as(defaultMimetypeToReturnedMimetype("text/csv;charset=UTF-8")))
    } else
      crudServiceFS.getRawCassandra(uuid).flatMap {
        case (payload, _) if payload.lines.size < 2 =>
          handleRawPath("/" + uuid, isReactive, limit)(defaultMimetypeToReturnedMimetype)
        case (payload, mimetype) => Future.successful(Ok(payload).as(defaultMimetypeToReturnedMimetype(mimetype)))
      }
  }

  val commaByteString = ByteString(",", StandardCharsets.UTF_8)
  val pathHeader = ByteString("path,last_modified,uuid")
  val pathHeaderSource: Source[ByteString, NotUsed] = Source.single(pathHeader)

  def handleRawPath(path: String, isReactive: Boolean, limit: Int)(
    defaultMimetypeToReturnedMimetype: String => String
  ) = {
    val pathByteString = ByteString(path, StandardCharsets.UTF_8)
    if (isReactive) {
      val src = crudServiceFS
        .getRawPathHistoryReactive(path)
        .map {
          case (time, uuid) =>
            endln ++
              pathByteString ++
              commaByteString ++
              ByteString(dtf.print(time), StandardCharsets.UTF_8) ++
              commaByteString ++
              ByteString(uuid, StandardCharsets.UTF_8)
        }
      Future.successful(
        Ok.chunked(pathHeaderSource.concat(src)).as(defaultMimetypeToReturnedMimetype("text/csv;charset=UTF-8"))
      )
    } else
      crudServiceFS.getRawPathHistory(path, limit).map { vec =>
        val payload = vec.foldLeft(pathHeader) {
          case (bytes, (time, uuid)) =>
            bytes ++
              endln ++
              pathByteString ++
              commaByteString ++
              ByteString(dtf.print(time), StandardCharsets.UTF_8) ++
              commaByteString ++
              ByteString(uuid, StandardCharsets.UTF_8)
        }
        Ok(payload).as(defaultMimetypeToReturnedMimetype("text/csv;charset=UTF-8"))
      }
  }

  def handlePoisonPill() = Action { implicit req =>
    if (!isAdminEvenNonProd(req)) {
      Forbidden("Not authorized")
    } else {
      val hostOpt = req.getQueryString("host")
      val jvmOpt = req.getQueryString("jvm")

      // retain the old behavior
      if (hostOpt.isEmpty || jvmOpt.isEmpty) {
        logger.info("Got poison pill. Will now exit.")
        cmwell.util.concurrent.SimpleScheduler.schedule(1 seconds) {
          sys.exit(1)
        }
        Ok("Goodbye")
      } else {
        val host = hostOpt.get
        val jvm = jvmOpt.get

        Grid.selectActor(ClientActor.name, GridJvm(host, jvm)) ! RestartJvm

        Ok(s"Restarted $jvm at $host")
      }
    }
  }

  def handleZzPost(uzid: String) = Action.async(parse.raw) { implicit req =>
    val allowed = isAdminEvenNonProd(req)
    req.body.asBytes() match {
      case Some(payload) if allowed =>
        val ttl = req.getQueryString("ttl").fold(0)(_.toInt)
        crudServiceFS.zStore
          .put(uzid, payload.toArray[Byte], ttl, req.queryString.keySet("batched"))
          .map(_ => Ok("""{"success":true}"""))
          .recover {
            case e => InternalServerError(s"""{"success":false,"message":"${e.getMessage}"}""")
          }
      case None if allowed => Future.successful(BadRequest("POST body may not be empty!"))
      case _               => Future.successful(Forbidden("Not allowed to use zz"))
    }
  }

  def handleStpControl(agent: String) = Action.async(parse.raw) { implicit req =>

    val p = Promise[Result]()

    val infotonPath = s"/meta/sys/agents/sparql/$agent"
    val flag = req.getQueryString("enabled").flatMap(asBoolean).getOrElse(true)

    val tokenOpt = authUtils.extractTokenFrom(req)
    val modifier = req.attrs(Attrs.UserName)

    (authUtils.isOperationAllowedForUser(security.Admin, tokenOpt)) match {
      case true => {
        val infotons = crudServiceFS.getInfotonByPathAsync(infotonPath)

        infotons.onComplete{
          case Success(infotonBox) => {
            infotonBox.isEmpty match {
              case false => {
                val fieldsOption = infotonBox.head.fields
                val activeFlag = ("active" -> Set(FieldValue(flag)))

                val newFields = fieldsOption match {
                  case Some(fields) => fields + activeFlag
                  case None => Map(activeFlag)
                }

                val firstInfoton = infotonBox.head
                val newInfoton = firstInfoton.copyInfoton(firstInfoton.systemFields.copy(lastModified = new DateTime(System.currentTimeMillis),
                  lastModifiedBy = modifier), fields=Some(newFields))
                val deletes = Map(infotonPath ->  Map("active" -> None))

                crudServiceFS.upsertInfotons(inserts = List(newInfoton), deletes = deletes, deletesModifier = modifier).onComplete({
                  case Success(_)=> p.completeWith(Future.successful(Ok("""{"success":true}""")))
                  case Failure(ex) => {
                    logger.debug(ex.getMessage)
                    throw ex
                  }
                })
              }
              case _ =>  p.completeWith(Future.successful(NotFound(s"Config infoton: $infotonPath  not found")))
            }
          }
          case Failure(ex) => p.completeWith(Future.successful(NotFound(s"Config infoton: $infotonPath not found")))
        }
      }
      case _ => p.completeWith(Future.successful(Forbidden("Not allowed to use stp")))
    }

    p.future

  }



  def handleKafkaConsume(topic: String, partition: Int): Action[AnyContent] = Action { implicit req =>
    val isSysTopic = {
      val sysTopics = Set("persist_topic", "index_topic", "persist_topic.priority", "index_topic.priority")
      sysTopics(topic)
    }
    if (isSysTopic && !authUtils.isOperationAllowedForUser(Admin, authUtils.extractTokenFrom(req), evenForNonProdEnv = true))
      Forbidden("Consuming this topic requires an Admin token.")
    else {
      val offset = req.getQueryString("offset").fold(0L)(_.toLong)
      val maxLengthOpt = req.getQueryString("max-length").map(_.toLong)
      val isText = req.getQueryString("format").fold(false)(_ == "text")

      val source = crudServiceFS.consumeKafka(topic, partition, offset, maxLengthOpt)
      Ok.chunked(source.map { bytes => (
          if(isSysTopic)  CommandSerializer.decode(bytes).toString
          else if(isText) new String(bytes, StandardCharsets.UTF_8)
          else            bytes.mkString(",")
        ) + "\n"
      })
    }
  }


  def requestDetailedView(path: String) = Action.async { implicit req =>
    {
      implicit val timeout = Timeout(2.seconds)
      import akka.pattern.ask
      val actorPath = Base64.decodeBase64String(path, "UTF-8")
      val f = (Grid.selectByPath(actorPath) ? GetRequest).mapTo[CmwellRequest]
      f.map { cmwReq =>
          Ok(s"""
             | Type: ${cmwReq.requestType}
             | Path: ${cmwReq.path}
             | Query: ${cmwReq.queryString}
             | Body: ${cmwReq.requestBody}
          """.stripMargin)
        }
        .recover {
          case t: Throwable => Ok("This request is not monitored anymore")
        }
    }
  }

  def startRequestMonitoring = Action {
    RequestMonitor.startMonitoring
    Ok("Started monitor requests")
  }

  def stopRequestMonitoring = Action {
    RequestMonitor.stopMonitoring
    Ok("Stopped monitor requests")
  }

  def handleCssh = Action {
    Ok(generateCsshCommand("cssh --username"))
  }

  def handleCsshx = Action {
    Ok(generateCsshCommand("csshX --login"))
  }

  private def generateCsshCommand(command: String) = {
    val hosts = Grid.availableMachines.mkString(" ")
    val user = System.getProperty("user.name")
    s"$command $user $hosts"
  }

  private def isAdminEvenNonProd(r: Request[_]): Boolean = {
    authUtils.isOperationAllowedForUser(Admin, authUtils.extractTokenFrom(r), evenForNonProdEnv = true)
  }

}

case class ParamExtractor(name: String, value: String => Boolean) {
  def unapply(request: RequestHeader): Boolean = request.getQueryString(name).exists(value)
}

object Operation {
  private[this] def func(s: String)(t: String) = t.equalsIgnoreCase(s)
  // format: off
  val search            = ParamExtractor("op", func("search")(_))
  val aggregate         = ParamExtractor("op", {s => s.equalsIgnoreCase("aggregate") || s.equalsIgnoreCase("stats")})
  val read              = ParamExtractor("op", func("read")(_))
  val startScroll       = ParamExtractor("op", func("create-iterator")(_))
  val scroll            = ParamExtractor("op", func("next-chunk")(_))
  val createConsumer    = ParamExtractor("op", func("create-consumer")(_))
  val consume           = ParamExtractor("op", func("consume")(_))
  val subscribe         = ParamExtractor("op", func("subscribe")(_))
  val unsubscribe       = ParamExtractor("op", func("unsubscribe")(_))
  val pull              = ParamExtractor("op", func("pull")(_))
  val stream            = ParamExtractor("op", func("stream")(_))
  val multiStream       = ParamExtractor("op", func("mstream")(_))
  val superStream       = ParamExtractor("op", func("sstream")(_))
  val queueStream       = ParamExtractor("op", func("qstream")(_))
  val bulkConsumer      = ParamExtractor("op", func("bulk-consume")(_))
  val fix               = ParamExtractor("op", func("x-fix")(_))
  val info              = ParamExtractor("op", func("x-info")(_))
  val verify            = ParamExtractor("op", func("x-verify")(_))
  val purgeAll          = ParamExtractor("op", func("purge-all")(_))
  val purgeLast         = ParamExtractor("op", func("purge-last")(_))
  val rollback          = ParamExtractor("op", func("rollback")(_)) // alias for purge-last
  val purgeHistory      = ParamExtractor("op", func("purge-history")(_))
  // format: on
}

object XCmWellType {
  val File = CMWellPostType("FILE")
  val FileMD = CMWellPostType("FILE_MD")
  val Object = CMWellPostType("OBJ")
  val Link = CMWellPostType("LN")
}

case class CMWellPostType(xCmWellType: String) {
  def unapply(request: RequestHeader): Boolean =
    request.headers.get("X-CM-WELL-TYPE").exists(_.equalsIgnoreCase(xCmWellType))
}

class SpaMissingException(msg: String) extends Exception(msg)
