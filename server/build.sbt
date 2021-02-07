import play.twirl.sbt.SbtTwirl
import play.sbt.PlayScala
import cmwell.build.Versions

name := "server"
description := "CM-Well Project"
organization in Global := "cmwell"                                           //see project/build.sbt commented out code,
                                                                             // to understand this commented out code:
//version in Global := "1.2." + sys.env.getOrElse("BUILD_NUMBER","x-SNAPSHOT") //build.JenkinsEnv.buildNumber.getOrElse("x-SNAPSHOT")
shellPrompt in ThisBuild := { state => Project.extract(state).currentRef.project + "> " }

def refreshVersion = Command.command("refreshVersion") { state =>
  val extracted = Project extract state
  import extracted._
  /* - At first I thought to manually set the version. It seems unimportant - just refresh the session
    val result: Option[(State, Result[String])] = Project.runTask(dynver, state)
    result match {
      case None => state.fail // Key wasn't defined.
      case Some((newState, Inc(inc))) => state.fail // error detail, inc is of type Incomplete, use Incomplete.show(inc.tpe) to get an error message
      case Some((newState, Value(v))) =>
        println(s"Setting the version to $v")
        appendWithoutSession(Seq(version := v), state) // do something with v: inc.Analysis
    }
  */
  state.log.info("refreshing version")
  appendWithoutSession(Seq(), state) // do something with v: inc.Analysis
}

coverageMinimum := 70
coverageFailOnMinimum := false
coverageHighlighting := true

ThisBuild / commands += refreshVersion

val dirtyEnd = """.*(\d\d\d\d\d\d\d\d)(-\d\d\d\d)$""".r
def stripTime(version: String) = version match {
  case dirtyEnd(date, time) => version.replace("+"+date, "-"+date).stripSuffix(time)
  case _ => version
}
ThisBuild / version ~= stripTime
ThisBuild / dynver ~= stripTime

//Do not change the format of the line below, it will affect (badly) the CI-CD in github
scalaVersion in Global := "2.13.1"

//javacOptions ++= Seq("-source", "1.8", "-target", "1.8", "-Xlint")
initialize := {
  import nl.gn0s1s.bump.SemVer
  val _ = initialize.value
  if (SemVer(sys.props("java.specification.version")) < SemVer("1.8"))
    sys.error("Java 8 or higher is required for CM-Well!")
}
updateOptions in Global := updateOptions.in(Global).value.withCachedResolution(true).withCircularDependencyLevel(CircularDependencyLevel.Error)
scalacOptions in Global ++= Seq("-unchecked", "-feature", "-deprecation", "-target:jvm-1.8")
cancelable in Global := true

dependenciesManager in Global := {
  case ("ch.qos.logback","logback-classic")                        => "ch.qos.logback" % "logback-classic" % "1.2.3"
  case ("com.avast","bytecompressor")                              => "com.avast" %% "bytecompressor"         % "1.2.2"
  case ("com.avast","bytecompressor-huffman")                      => "com.avast" %% "bytecompressor-huffman" % "1.2.2"
  case ("com.avast","bytecompressor-jsnappy")                      => "com.avast" %% "bytecompressor-jsnappy" % "1.2.2"
  case ("com.avast","bytecompressor-zlib")                         => "com.avast" %% "bytecompressor-zlib"    % "1.2.2"
  case ("com.datastax.cassandra","cassandra-driver-core")          => "com.datastax.cassandra" % "cassandra-driver-core" % "3.7.1"
  case ("com.dimafeng","testcontainers-scala")                     => "com.dimafeng" %% "testcontainers-scala" % "0.33.0"
  case ("com.ecyrd.speed4j","speed4j")                             => "com.ecyrd.speed4j" % "speed4j" % "0.18"
  case ("com.fasterxml.jackson.core", art)                         => "com.fasterxml.jackson.core" % art % "2.10.0"
  case ("com.github.andrewoma.dexx","collection")                  => "com.github.andrewoma.dexx" % "collection" % "0.7"
  case ("com.github.tomakehurst", "wiremock")                      => "com.github.tomakehurst" % "wiremock" % "2.25.1"
  case ("com.github.t3hnar", "scala-bcrypt")                       => "com.github.t3hnar" %% "scala-bcrypt" % "4.1"
  case ("com.google.code.findbugs","jsr305")                       => "com.google.code.findbugs" % "jsr305" % "3.0.2"
  case ("com.google.guava","guava")                                => "com.google.guava" % "guava" % "28.1-jre"
  case ("com.lihaoyi", "ujson")                                    => "com.lihaoyi" %% "ujson" % "0.8.0"
  case ("com.pauldijou", "jwt-core")                               => "com.pauldijou" %% "jwt-core" % "4.1.0"
  case ("com.lightbend.akka", "akka-stream-alpakka-cassandra")     => "com.lightbend.akka" %% "akka-stream-alpakka-cassandra" % "1.1.2"
  case ("com.ning","async-http-client")                            => "com.ning" % "async-http-client" % "1.9.40"
  case ("com.spatial4j","spatial4j")                               => "com.spatial4j" % "spatial4j" % "0.5"
  case ("com.tinkerpop.blueprints","blueprints-core")              => "com.tinkerpop.blueprints" % "blueprints-core" % "2.6.0"
  case ("com.tinkerpop.gremlin","gremlin-groovy")                  => "com.tinkerpop.gremlin" % "gremlin-groovy" % "2.6.0"
  case ("com.thaiopensource","jing")                               => "com.thaiopensource" % "jing" % "20091111"
  case ("com.typesafe","config")                                   => "com.typesafe" % "config" % "1.4.0"
  case ("com.typesafe.scala-logging","scala-logging")              => "com.typesafe.scala-logging" %% "scala-logging" % "3.9.2"
  case ("com.typesafe.akka", "akka-stream-kafka")                  => "com.typesafe.akka" %% "akka-stream-kafka" % "1.1.0"
  case ("com.typesafe.akka", "akka-stream-contrib")                => "com.typesafe.akka" %% "akka-stream-contrib" % "0.10"
  case ("com.typesafe.akka", "akka-http")                          => "com.typesafe.akka" %% "akka-http" % "10.1.11"
  case ("com.typesafe.akka",art)                                   => "com.typesafe.akka" %% art % "2.5.26"
  case ("com.typesafe.play", "twirl-api")                          => "com.typesafe.play" %% "twirl-api" % "1.3.13"
  case ("com.typesafe.play", "play-json")                          => "com.typesafe.play" %% "play-json" % "2.7.4"
  case ("com.typesafe.play", art)                                  => "com.typesafe.play" %% art % Versions.play
  case ("com.twitter","chill-akka")                                => "com.twitter" %% "chill-akka" % "0.5.2"
  case ("com.whisk",art)                                           => "com.whisk" %% art % "0.9.7"
  case ("commons-io","commons-io")                                 => "commons-io" % "commons-io" % "2.6"
  case ("commons-codec","commons-codec")                           => "commons-codec" % "commons-codec" % "1.13"
  case ("commons-lang","commons-lang")                             => "commons-lang" % "commons-lang" % "2.6"
  case ("eu.piotrbuda","scalawebsocket")                           => "eu.piotrbuda" %% "scalawebsocket" % "0.1.1"
  case ("io.netty",art)                                            => "io.netty" % art % "4.1.42.Final"
  case ("io.circe", art)                                           => "io.circe" %% art % "0.12.2"
  case ("io.dropwizard.metrics",art)                               => "io.dropwizard.metrics" % art % "4.1.1" // make sure this is a compatible version with "nl.grons" metrics dependencies!
  case ("com.jcraft","jsch")                                       => "com.jcraft" % "jsch" % "0.1.55"
  case ("jakarta.ws.rs","jakarta.ws.rs-api")                       => "jakarta.ws.rs" % "jakarta.ws.rs-api" % "2.1.6"
  case ("joda-time","joda-time")                                   => "joda-time" % "joda-time" % "2.10.4"
  case ("junit","junit")                                           => "junit" % "junit" % "4.12"
  case ("mx4j","mx4j-tools")                                       => "mx4j" % "mx4j-tools" % "3.0.1"
  case ("net.jcazevedo", "moultingyaml")                           => "net.jcazevedo" %% "moultingyaml" % "0.4.1"
  case ("org.lz4","lz4-java")                                      => "org.lz4" % "lz4-java" % "1.6.0"
  case ("net.lingala.zip4j", "zip4j")                              => "net.lingala.zip4j" % "zip4j" % "2.2.3"
  case ("net.sf.ehcache","ehcache")                                => "net.sf.ehcache" % "ehcache" % "2.10.2"
  case ("nl.grons", art)                                           => "nl.grons" %% art % "4.1.1" // make sure to update also "io.dropwizard.metrics" dependencies
  case ("org.apache.abdera",art)                                   => "org.apache.abdera" % art % "1.1.3"
  case ("org.apache.cassandra","apache-cassandra")                 => "org.apache.cassandra" % "apache-cassandra" % Versions.cassandra
  case ("org.apache.commons","commons-compress")                   => "org.apache.commons" % "commons-compress" % "1.19"
  case ("org.apache.commons", "commons-lang3")                     => "org.apache.commons" % "commons-lang3" % "3.9"
  case ("org.apache.commons","commons-csv")                        => "org.apache.commons" % "commons-csv" % "1.7"
  case ("org.apache.httpcomponents","httpclient")                  => "org.apache.httpcomponents" % "httpclient" % "4.5.10"
  case ("org.apache.httpcomponents","httpcore")                    => "org.apache.httpcomponents" % "httpcore" % "4.4.12"
  case ("org.apache.jena",art) if(Set("apache-jena",
    "apache-jena-libs",
    "apache-jena-osgi",
    "jena",
    "jena-arq",
    "jena-base",
    "jena-core",
    "jena-csv",
    "jena-cmds",
    "jena-elephas",
    "jena-elephas-common",
    "jena-elephas-commonjena-elephas-common",
    "jena-elephas-io",
    "jena-elephas-mapreduce",
    "jena-elephas-stats",
    "jena-extras",
    "jena-iri",
    "jena-jdbc",
    "jena-jdbc-core",
    "jena-jdbc-driver-bundle",
    "jena-jdbc-driver-mem",
    "jena-jdbc-driver-remote",
    "jena-jdbc-driver-tdb",
    "jena-maven-tools",
    "jena-osgi",
    "jena-permissions",
    "jena-querybuilder",
    "jena-sdb",
    "jena-shaded-guava",
    "jena-spatial",
    "jena-tdb",
    "jena-text")(art))                                             => "org.apache.jena" % art % "3.3.0"
  case ("org.apache.jena",art) => throw new Exception(s"jena artifact: $art is not in the 3.1.0 version list")
  case ("org.apache.kafka", "kafka")                               => "org.apache.kafka" %% "kafka" % Versions.kafka
  case ("org.apache.kafka", "kafka-clients")                       => "org.apache.kafka" % "kafka-clients" % Versions.kafka
  case ("org.apache.logging.log4j", "log4j-to-slf4j")              => "org.apache.logging.log4j" % "log4j-to-slf4j" % "2.12.1"
  case ("org.apache.tika",art)                                     => "org.apache.tika" % art % "1.22" jar()
  case ("org.apache.thrift","libthrift")                           => "org.apache.thrift" % "libthrift" % "0.9.3"
  case ("org.apache.zookeeper", "zookeeper")                       => "org.apache.zookeeper" % "zookeeper" % Versions.zookeeper
  case ("org.aspectj","aspectjweaver")                             => "org.aspectj" % "aspectjweaver" % "1.8.9"
  case ("org.codehaus.groovy",art)                                 => "org.codehaus.groovy" % art % "2.4.7"
  case ("org.codehaus.plexus","plexus-archiver")                   => "org.codehaus.plexus" % "plexus-archiver" % "4.2.0"
  case ("org.codehaus.plexus","plexus-container-default")          => "org.codehaus.plexus" % "plexus-container-default" % "2.0.0" //"1.6"
  case ("org.codehaus.plexus","plexus-utils")                      => "org.codehaus.plexus" % "plexus-utils" % "3.3.0"
  case ("org.codehaus.woodstox","woodstox-asl")                    => "org.codehaus.woodstox" % "woodstox-asl" % "3.2.7"
  case ("org.elasticsearch","elasticsearch")                       => "org.elasticsearch" % "elasticsearch" % Versions.elasticsearch
  case ("org.elasticsearch.client", "transport")                   => "org.elasticsearch.client" % "transport" % Versions.elasticsearch
  case ("org.elasticsearch.distribution.zip", "elasticsearch-oss") => "org.elasticsearch.distribution.zip" % "elasticsearch-oss" % Versions.elasticsearch
  case ("org.elasticsearch", "metrics-elasticsearch-reporter")     => "org.elasticsearch" % "metrics-elasticsearch-reporter" % "2.2.0"
  case ("org.hdrhistogram","HdrHistogram")                         => "org.hdrhistogram" % "HdrHistogram" % "2.1.11"
  case ("org.jfarcand","wcs")                                      => "org.jfarcand" % "wcs" % "1.3"
  case ("org.jdom","jdom2")                                        => "org.jdom" % "jdom2" % "2.0.6"
  case ("org.joda","joda-convert")                                 => "org.joda" % "joda-convert" % "2.2.1"
  case("org.openrdf.sesame", art)                                  => "org.openrdf.sesame" % art % "4.1.2"
  case ("org.pac4j", "play-pac4j")                                 => "org.pac4j" % "play-pac4j_scala2.11" % "1.3.0" // % "play-pac4j-scala" % "2.0.1"
  case ("org.pac4j", "pac4j-saml")                                 => "org.pac4j" % "pac4j-saml" % "1.7.0"           // "1.8.7"
  case ("org.pac4j", "pac4j-oauth")                                => "org.pac4j" % "pac4j-oauth" % "1.7.0"          // "1.8.7"
  case ("org.pac4j", "pac4j-openid")                               => "org.pac4j" % "pac4j-openid" % "1.7.0"         // "1.8.7"
  case ("org.rogach","scallop")                                    => "org.rogach" %% "scallop" % "3.3.1"
  case ("org.scala-lang",art)                                      => "org.scala-lang" % art % scalaVersion.value
  case ("org.scalacheck","scalacheck")                             => "org.scalacheck" %% "scalacheck" % "1.14.2"
  case ("org.scalatest","scalatest")                               => "org.scalatest" %% "scalatest" % "3.0.8"
  case ("org.scala-lang.modules", "scala-parser-combinators")      => "org.scala-lang.modules" %% "scala-parser-combinators" % "1.0.4"
  case ("org.scala-lang.modules", "scala-parallel-collections")    => "org.scala-lang.modules" %% "scala-parallel-collections" % "0.2.0"
  case ("org.scala-lang.modules", "scala-xml")                     => "org.scala-lang.modules" %% "scala-xml" % "1.2.0"
  case ("org.slf4j",art)                                           => "org.slf4j" % art % "1.7.28"
  case ("org.xerial.snappy","snappy-java")                         => "org.xerial.snappy" % "snappy-java" % "1.1.2.4"
  case ("org.yaml","snakeyaml")                                    => "org.yaml" % "snakeyaml" % "1.25"
  case ("xerces","xercesImpl")                                     => "xerces" % "xercesImpl" % "2.12.0"
  case ("xml-apis","xml-apis")                                     => "xml-apis" % "xml-apis" % "1.4.01"
  case ("uk.org.lidalia","sysout-over-slf4j")                      => "uk.org.lidalia" % "sysout-over-slf4j" % "1.0.2"
  case ("nl.gn0s1s", "bump")                                       => "nl.gn0s1s" %% "bump" % "0.1.3"
  case ("org.scala-lang.modules", "scala-collection-compat")       => "org.scala-lang.modules" %% "scala-collection-compat" % "2.1.3"
}

//dependencyOverrides in Global ++= {
//  val dm = dependenciesManager.value
//  Set(
//    dm("ch.qos.logback", "logback-classic"),
//    dm("com.fasterxml.jackson.core", "jackson-annotations"),
//    dm("com.fasterxml.jackson.core", "jackson-core"),
//    dm("com.fasterxml.jackson.core", "jackson-databind"),
//    dm("com.google.guava", "guava"),
//    dm("commons-codec", "commons-codec"),
//    dm("commons-lang", "commons-lang"),
//    dm("joda-time", "joda-time"),
//    dm("junit", "junit"),
//    dm("org.codehaus.plexus", "plexus-utils"),
//    dm("org.apache.commons", "commons-compress"),
//    dm("org.apache.httpcomponents", "httpclient"),
//    dm("org.codehaus.woodstox", "woodstox-asl"),
//    dm("org.joda", "joda-convert"),
//    dm("org.scala-lang", "scala-compiler"),
//    dm("org.scala-lang", "scala-reflect"),
//    dm("org.scala-lang", "scala-library"),
//    dm("org.slf4j", "jcl-over-slf4j"),
//    dm("org.slf4j", "slf4j-api"),
//    dm("xerces", "xercesImpl"),
//    dm("xml-apis", "xml-apis")
//  )
//}

excludeDependencies in ThisBuild += "org.slf4j" % "slf4j-jdk14"

//conflictManager in Global := ConflictManager.strict //TODO: ideally we should use this to prevent jar hell (conflicts will explode to our faces explicitly at update phase)

printDate := streams.value.log.info("date: " + org.joda.time.DateTime.now().toString())

lazy val DomainUtil = config("domainUtil") extend(Compile)

lazy val util          = (project in file("cmwell-util")).enablePlugins(CMWellBuild)
lazy val kafkaAssigner = (project in file("cmwell-kafka-assigner")).enablePlugins(CMWellBuild)
lazy val dao           = (project in file("cmwell-dao")).enablePlugins(CMWellBuild)
lazy val domain       = (project in file("cmwell-domain")).enablePlugins(CMWellBuild).configs(DomainUtil)
  .settings(
    inConfig(DomainUtil)(Defaults.configSettings),
    (Test / managedSources) += baseDirectory.value / "src" / "domainUtil" / "scala" / "domain" /"testUtil" / "InfotonGenerator.scala",
  ) dependsOn(util)
lazy val zstore        = (project in file("cmwell-zstore")).enablePlugins(CMWellBuild, CassandraPlugin)             dependsOn(dao, util % "compile->compile;test->test")
lazy val common        = (project in file("cmwell-common")).enablePlugins(CMWellBuild, BuildInfoPlugin)
  .configs(DomainUtil) dependsOn(zstore, domain % "compile->compile;test->domainUtil")
lazy val grid          = (project in file("cmwell-grid")).enablePlugins(CMWellBuild)                                dependsOn(util)
lazy val rts           = (project in file("cmwell-rts")).enablePlugins(CMWellBuild)                                 dependsOn(domain % "compile->compile;test->domainUtil", grid, formats)
lazy val fts           = (project in file("cmwell-fts")).enablePlugins(CMWellBuild)                                 dependsOn(domain % "compile->compile;test->domainUtil", common)
lazy val formats       = (project in file("cmwell-formats")).enablePlugins(CMWellBuild) dependsOn(domain, common, fts)
lazy val irw           = (project in file("cmwell-irw")).enablePlugins(CMWellBuild, CassandraPlugin)                dependsOn(dao, domain % "compile->compile;test->domainUtil", common, zstore, util % "compile->compile;test->test")
lazy val stortill      = (project in file("cmwell-stortill")).enablePlugins(CMWellBuild)                            dependsOn(domain, irw, fts, formats)
lazy val bg            = (project in file("cmwell-bg")).enablePlugins(CMWellBuild, SbtKafkaPlugin, CassandraPlugin) dependsOn(kafkaAssigner, irw, domain % "compile->compile;test->domainUtil", fts, grid, zstore, tracking, util % "compile->compile;test->test")
lazy val consIt        = (project in file("cmwell-it")).enablePlugins(CMWellBuild).settings(
  // scalastyle settings to enable it for integration tests:
  // this is low-level and should be updated on every version upgrade of the plugin (if needed)
  Seq(
    (scalastyleConfig in IntegrationTest) := (scalastyleConfig in scalastyle).value,
    (scalastyleConfigUrl in IntegrationTest) := None,
    (scalastyleConfigUrlCacheFile in IntegrationTest) := "scalastyle-it-config.xml",
    (scalastyleConfigRefreshHours in IntegrationTest) := (scalastyleConfigRefreshHours in scalastyle).value,
    (scalastyleTarget in IntegrationTest) := target.value / "scalastyle-it-result.xml",
    (scalastyleFailOnError in IntegrationTest) := (scalastyleFailOnError in scalastyle).value,
    (scalastyleFailOnWarning in IntegrationTest) := (scalastyleFailOnWarning in scalastyle).value,
    (scalastyleSources in IntegrationTest) := (unmanagedSourceDirectories in IntegrationTest).value,
  ) ++ Project.inConfig(IntegrationTest)(ScalastylePlugin.rawScalastyleSettings()))                                 dependsOn(domain, common % "compile->compile;it->domainUtil", ws) configs(IntegrationTest)
lazy val ctrl          = (project in file("cmwell-controller")).enablePlugins(CMWellBuild)                          dependsOn(grid, common)
lazy val dc            = (project in file("cmwell-dc")).enablePlugins(CMWellBuild, JavaAppPackaging)                dependsOn(tracking, ctrl, sparqlAgent)
lazy val cons          = (project in file("cmwell-cons")).enablePlugins(CMWellBuild)                                dependsOn(common, util, ctrl) aggregate(ws, ctrl, dc)
lazy val pluginGremlin = (project in file("cmwell-plugin-gremlin")).enablePlugins(CMWellBuild)
lazy val spa           = (project in file("cmwell-spa")) .enablePlugins(CMWellBuild)
lazy val dataTools     = (project in file("cmwell-data-tools")).settings(
                            crossScalaVersions := List("2.12.10", scalaVersion.value),
                          ).enablePlugins(CMWellBuild)
lazy val dataToolsApp  = (project in file("cmwell-data-tools-app")).enablePlugins(CMWellBuild)                      dependsOn(dataTools)
lazy val sparqlAgent   = (project in file("cmwell-sparql-agent")).enablePlugins(CMWellBuild)                        dependsOn(dataTools, grid, util, ctrl)
lazy val tracking      = (project in file("cmwell-tracking")).enablePlugins(CMWellBuild)                            dependsOn(util, zstore, grid, irw, ctrl)
lazy val ws            = (project in file("cmwell-ws")).enablePlugins(CMWellBuild, PlayScala, SbtTwirl, PlayNettyServer)
                                                       .disablePlugins(PlayAkkaHttpServer)                          dependsOn(domain, common, formats, fts, irw, rts, ctrl, stortill, zstore, tracking)

testOptions in Test in ThisBuild += Tests.Argument(TestFrameworks.ScalaTest, "-oD")
testOptions in Test in ThisBuild += Tests.Argument(TestFrameworks.ScalaTest, "-W", "10", "2")
testOptions in IntegrationTest in ThisBuild += Tests.Argument(TestFrameworks.ScalaTest, "-oD")
testOptions in IntegrationTest in ThisBuild += Tests.Argument(TestFrameworks.ScalaTest, "-W", "10", "2")

addCommandAlias("fullTest","; Test/test ; IntegrationTest/test")

addCommandAlias("ccft","; clean ; compile ; fullTest")

credentials in Global ~= {
  seq => {
    val credentials = for {
      username <- sys.env.get("CMWELL_NEXUS_USERNAME")
      password <- sys.env.get("CMWELL_NEXUS_PASSWORD")
    } yield Credentials(
      realm = "Sonatype Nexus Repository Manager",
      host = "builder.clearforest.com",
      userName = username,
      passwd = password)

    seq ++ credentials
  }
}

publishTo in Global := {
  sys.env.get("CMWELL_NEXUS_HOST").map { nexus =>
    if (version.value.trim.endsWith("SNAPSHOT"))
      "CMWell Snapshots" at nexus + "snapshots"
    else
      "CMWell Releases"  at nexus + "releases"
  }
}
