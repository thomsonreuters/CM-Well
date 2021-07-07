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


package cmwell.tools.data.downloader.consumer

import akka.actor.ActorSystem
import akka.http.scaladsl.model.StatusCodes
import akka.stream.scaladsl.{Keep, Sink}
import akka.stream.{ActorMaterializer, Materializer}
import cmwell.tools.data.helpers.BaseWiremockSpec
import cmwell.tools.data.utils.akka.HeaderOps._
import com.github.tomakehurst.wiremock.client.WireMock._
import com.github.tomakehurst.wiremock.http.Fault
import com.github.tomakehurst.wiremock.stubbing.Scenario
import com.typesafe.config.ConfigFactory


/**
  * Created by matan on 12/9/16.
  */
class ConsumerSpec extends BaseWiremockSpec {
  val scenario = "scenario"

  val config = ConfigFactory.load()

  implicit val system: ActorSystem = ActorSystem.create("reactive-tools-system")
  implicit val mat: Materializer = ActorMaterializer()

  override protected def afterAll(): Unit = {
    system.terminate()
    super.afterAll()
  }

  ignore /*"Consumer"*/ should "be resilient against HTTP 429" in {
    val tooManyRequests = "too-many-requests"
    val ok = "ok"
    val noContent = "no-content"

    stubFor(post(urlPathMatching("/_out"))
      .willReturn(aResponse()
        .withBody("response")
        .withStatus(StatusCodes.OK.intValue))
    )

    stubFor(get(urlPathMatching("/.*")).inScenario(scenario)
      .whenScenarioStateIs(Scenario.STARTED)
      .willReturn(aResponse()
        .withStatus(StatusCodes.OK.intValue)
        .withHeader(CMWELL_POSITION, "3AAAMHwv"))
      .willSetStateTo(tooManyRequests)
    )

    stubFor(get(urlPathMatching("/.*")).inScenario(scenario)
      .whenScenarioStateIs(tooManyRequests)
      .willReturn(aResponse()
        .withStatus(StatusCodes.TooManyRequests.intValue)
        .withHeader(CMWELL_POSITION, "3AAAMHwv"))
      .willSetStateTo(ok)
    )

    stubFor(get(urlPathMatching("/.*")).inScenario(scenario)
      .whenScenarioStateIs(ok)
      .willReturn(aResponse()
        .withStatus(StatusCodes.OK.intValue)
        .withBody("one\ttwo\tthree\tfour")
        .withHeader(CMWELL_POSITION, "3AAAMHwv"))
      .willSetStateTo(noContent)
    )

    stubFor(get(urlPathMatching("/.*")).inScenario(scenario)
      .whenScenarioStateIs(noContent)
      .willReturn(aResponse()
        .withStatus(StatusCodes.NoContent.intValue)
        .withHeader(CMWELL_POSITION, "3AAAMHwv"))
    )

    val result = Downloader.createTsvSource(baseUrl = s"localhost:${wireMockServer.port}")
      .map(_ => 1)
      .runFold(0)(_ + _)

    result.flatMap { r => r should be (1)}
  }

  ignore should "download all uuids while getting server error" in {

    val tsvsBeforeError = List(
      "path1\tlastModified1\tuuid1\tindexTime1\n",
      "path2\tlastModified2\tuuid2\tindexTime2\n"
    )
    val tsvsAfterError  = List(
      "path3\tlastModified3\tuuid3\tindexTime3\n",
      "path4\tlastModified4\tuuid4\tindexTime4\n"
    )
    val expectedTsvs    = tsvsBeforeError ++ tsvsAfterError

    val downloadSuccess1 = "download-success-1"
    val downloadFail = "download-fail"
    val downloadSuccess2 = "download-success-2"
    val noContent = "no-content"

    stubFor(get(urlPathMatching("/.*")).inScenario(scenario)
      .whenScenarioStateIs(Scenario.STARTED)
      .willReturn(aResponse()
        .withStatus(StatusCodes.OK.intValue)
        .withHeader(CMWELL_POSITION, "3AAAMHwv"))
      .willSetStateTo(downloadSuccess1)
    )

    stubFor(get(urlPathMatching("/_consume")).inScenario(scenario)
      .whenScenarioStateIs(downloadSuccess1)
      .willReturn(aResponse()
        .withBody(tsvsBeforeError.mkString)
        .withStatus(StatusCodes.OK.intValue)
        .withHeader(CMWELL_N, (tsvsBeforeError.size).toString)
        .withHeader(CMWELL_POSITION, "3AAAMHwv"))
      .willSetStateTo(downloadFail)
    )

    stubFor(get(urlPathMatching("/_consume")).inScenario(scenario)
      .whenScenarioStateIs(downloadFail)
      .willReturn(aResponse()
        .withStatus(StatusCodes.ServiceUnavailable.intValue))
      .willSetStateTo(downloadSuccess2)
    )

    stubFor(get(urlPathMatching("/_consume")).inScenario(scenario)
      .whenScenarioStateIs(downloadSuccess2)
      .willReturn(aResponse()
        .withBody(tsvsAfterError.mkString)
        .withStatus(StatusCodes.OK.intValue)
        .withHeader(CMWELL_N, (tsvsAfterError.size).toString)
        .withHeader(CMWELL_POSITION, "3AAAMHwv"))
      .willSetStateTo(noContent)
    )

    stubFor(get(urlPathMatching("/.*")).inScenario(scenario)
      .whenScenarioStateIs(noContent)
      .willReturn(aResponse()
        .withStatus(StatusCodes.NoContent.intValue)
        .withHeader(CMWELL_POSITION, "3AAAMHwv"))
    )

    val result = Downloader.createTsvSource(baseUrl = s"localhost:${wireMockServer.port}")
      .map(_ => 1)
      .runFold(0)(_ + _)

    result
      .flatMap { numDownloadedTsvs => numDownloadedTsvs should be (expectedTsvs.size ) }
      .flatMap { _ =>
        val numRequestsToConsume = wireMockServer.findAll(getRequestedFor(urlPathMatching("/_consume"))).size
        numRequestsToConsume should be (4)
      }
  }

  ignore should "be resilient against network error" in {

    val beforeCrushState = "before-crush-state"
    val crushState = "crush-state"
    val afterCrushState = "after-crush-state"

    stubFor(post(urlPathMatching("_out"))
      .willReturn(aResponse()
        .withBody("response")
        .withStatus(StatusCodes.OK.intValue))
    )

    stubFor(get(urlPathMatching("/")).inScenario(scenario)
      .whenScenarioStateIs(Scenario.STARTED)
      .willReturn(aResponse()
        .withStatus(StatusCodes.OK.intValue)
        .withHeader(CMWELL_POSITION, "dummy-token-value"))
      .willSetStateTo(beforeCrushState)
    )

    stubFor(get(urlPathMatching("/")).inScenario(scenario)
      .whenScenarioStateIs(beforeCrushState)
      .willReturn(aResponse()
        .withStatus(StatusCodes.OK.intValue)
        .withBody("one\ttwo\tthree\tfour")
        .withHeader(CMWELL_POSITION, "dummy-token-value2"))
      .willSetStateTo(crushState)
    )

    stubFor(get(urlPathMatching("/")).inScenario(scenario)
      .whenScenarioStateIs(crushState)
      .willReturn(aResponse()
        .withFault(Fault.RANDOM_DATA_THEN_CLOSE)
        .withStatus(StatusCodes.OK.intValue)
        .withHeader(CMWELL_POSITION, "dummy-token-value3"))
      .willSetStateTo(afterCrushState)
    )

    stubFor(get(urlPathMatching("/")).inScenario(scenario)
      .whenScenarioStateIs(afterCrushState)
      .willReturn(aResponse()
        .withStatus(StatusCodes.OK.intValue)
        .withBody("one\ttwo\tthree\tfour")
        .withHeader(CMWELL_POSITION, "dummy-token-value4"))
    )

    val result = Downloader.createTsvSource(baseUrl = s"localhost:${wireMockServer.port}")
      .map(_ => 1)
      .runFold(0)(_ + _)
    result.flatMap{_ => 1 should be (1)}
  }

  it should "be retry against persistent 5xx errors to a defined limit" in {

    val ec = scala.concurrent.ExecutionContext.Implicits.global

    val expectedRetries = config.hasPath("cmwell.downloader.consumer.http-retry-limit") match {
      case true => config.getInt("cmwell.downloader.consumer.http-retry-limit")
      case false => 0
    }

    stubFor(get(urlPathMatching("/.*")).inScenario("5xx")
      .whenScenarioStateIs(Scenario.STARTED)
      .willReturn(aResponse()
        .withStatus(StatusCodes.GatewayTimeout.intValue))
      .willSetStateTo(Scenario.STARTED)
    )

    val source = Downloader.createTsvSource(baseUrl = s"localhost:${wireMockServer.port}")(system, mat, ec)
    val future = source.take(1).toMat(Sink.seq)(Keep.right).run

    recoverToExceptionIf[Exception] {
      future.map(_ => 1)
    }.map ( _ => assert(wireMockServer.getAllServeEvents.size == expectedRetries + 1) )

  }


}
